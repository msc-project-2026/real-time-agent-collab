// Wires webhook events, meeting-resource resolution, join/leave state, and
// the headless-browser SDK runtime together. This module is the testable
// core: `browserRuntime` is injected so tests can supply a fake one instead
// of driving a real headless Chromium + Webex meeting (see
// orchestrator.test.cjs).
'use strict';

const { webexFetch } = require('./api');
const { parseCommand, isAddressedToBot, stripMention } = require('./commands');
const {
  classifyMeetingKind,
  resolveDestination,
  fetchMeetingWithRetry,
  isRoomMember,
  listActiveMeetings,
} = require('./meetings');

function createOrchestrator({ cfg, tokenStore, browserRuntime, log, transcription = null, meetingAgent = null }) {
  const state = new (require('./state').MeetingState)();
  let botId = null;
  let botName = null;
  let meetingPersonId = null;
  let pollTimer = null;
  let identityPromise = null;

  function findSdkMeetingFor(meeting, destination, sdkMeetings, { allowSole = false } = {}) {
    if (!Array.isArray(sdkMeetings) || !sdkMeetings.length) return null;
    const references = new Set([
      meeting?.id,
      meeting?.sipUrl,
      meeting?.sipAddress,
      meeting?.webLink,
      destination,
    ].filter(Boolean).map((value) => String(value).trim().toLowerCase()));
    const exact = sdkMeetings.find((sdkMeeting) =>
      Array.isArray(sdkMeeting.references) &&
      sdkMeeting.references.some((value) => references.has(String(value).trim().toLowerCase()))
    );
    return exact ?? (allowSole && sdkMeetings.length === 1 ? sdkMeetings[0] : null);
  }

  async function announce(roomId, markdown) {
    try {
      await webexFetch(cfg.botToken, '/messages', { method: 'POST', body: { roomId, markdown } });
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] failed to post to room ${roomId}: ${err?.message ?? err}`);
    }
  }

  async function ensureIdentities() {
    if (botId && meetingPersonId) return;
    if (identityPromise) return identityPromise;
    identityPromise = (async () => {
      if (!botId) {
        const bot = await webexFetch(cfg.botToken, '/people/me');
        botId = bot.id;
        botName = bot.displayName ?? bot.nickName ?? bot.firstName ?? null;
      }
      if (!meetingPersonId) {
        const me = await tokenStore.meetingFetch('/people/me');
        meetingPersonId = me.id;
      }
    })().finally(() => {
      identityPromise = null;
    });
    return identityPromise;
  }

  async function start() {
    await ensureIdentities();
    await browserRuntime.init(tokenStore.getToken());
    log?.info?.(`[webex-meeting-join] ready — bot=${botId} meeting-account=${meetingPersonId}`);
  }

  // Attempts to join a meeting once, guarded by state.withLock so a retried
  // webhook or a poll-sweep race can't double-join. Idempotent: a no-op if
  // already joined or explicitly suppressed by a user "leave" request.
  //
  // Takes the already-resolved `meeting` object rather than re-fetching by
  // id — both call sites (handleMeetingStarted, reconcile) already have it
  // from their own REST call, and fetching it twice was a real bug found
  // while writing the reconcile() test: an unnecessary extra REST round-trip
  // that's also an extra way for the join to fail.
  async function tryJoin(meeting, { announceFailure = true } = {}) {
    const meetingId = meeting?.id;
    const roomId = meeting?.roomId;
    if (!meetingId) return { skipped: 'no-id' };
    if (state.isSuppressed(meetingId)) return { skipped: 'suppressed' };
    if (state.isJoined(meetingId)) return { skipped: 'already-joined' };
    if (!roomId) return { skipped: 'no-room' }; // not a space meeting we can post into

    return state.withLock(meetingId, async () => {
      if (state.isSuppressed(meetingId) || state.isJoined(meetingId)) return { skipped: 'race' };

      // If startup identity discovery was temporarily unavailable, the
      // webhook/poll path retries it before making the membership decision.
      await ensureIdentities();
      const member = await isRoomMember(tokenStore.meetingFetch, roomId, meetingPersonId).catch(() => false);
      if (!member) return { skipped: 'not-a-member' };

      const { destination, type } = resolveDestination(meeting);
      const kind = classifyMeetingKind(meeting);

      try {
        // Propagate a token refreshed by the REST client into the long-lived
        // Browser SDK before every operation. init() is idempotent and only
        // updates the SDK credential when the token actually changed.
        await browserRuntime.init(tokenStore.getToken());
        const sdkMeetingId = await browserRuntime.join(destination, type);
        state.markJoined(meetingId, { roomId, kind, destination, sdkMeetingId });
        transcription?.startSession({ sdkMeetingId, roomId, meetingId });
      } catch (err) {
        // The Locus POST can commit the join and then reject while the SDK is
        // processing its response. Independently sync once at this boundary;
        // only an exact active-device match is accepted as recovered.
        const sdkMeetings = await browserRuntime.syncActive().catch(() => []);
        const recovered = findSdkMeetingFor(meeting, destination, sdkMeetings);
        if (recovered) {
          state.markJoined(meetingId, {
            roomId,
            kind,
            destination,
            sdkMeetingId: recovered.sdkMeetingId,
          });
          transcription?.startSession({ sdkMeetingId: recovered.sdkMeetingId, roomId, meetingId });
          log?.warn?.(
            `[webex-meeting-join] join response failed but active Locus state confirmed meeting=${meetingId}`
          );
        } else {
          log?.error?.(`[webex-meeting-join] join failed for meeting=${meetingId}: ${err?.message ?? err}`);
          if (announceFailure) {
            await announce(roomId, `I couldn't join the meeting that just started (${err?.message ?? 'unknown error'}). Please join manually if needed.`);
          }
          throw err;
        }
      }

      const label = kind === 'instant' ? 'the meeting that just started' : 'the scheduled meeting';
      await announce(roomId, `Joined ${label}${meeting.title ? ` (“${meeting.title}”)` : ''}. Say "leave meeting" and I'll step out.`);
      log?.info?.(`[webex-meeting-join] joined meeting=${meetingId} room=${roomId}`);
      return { joined: true };
    });
  }

  async function tryLeave(meetingId, { roomId, suppress = true } = {}) {
    return state.withLock(meetingId, async () => {
      const info = state.joined.get(meetingId);
      if (!info) return { skipped: 'not-joined' };
      try {
        await browserRuntime.init(tokenStore.getToken());
        await browserRuntime.leave({
          meetingId,
          sdkMeetingId: info.sdkMeetingId,
          destination: info.destination,
        });
      } catch (err) {
        log?.error?.(`[webex-meeting-join] leave failed for meeting=${meetingId}: ${err?.message ?? err}`);
        await announce(roomId, `I couldn't leave the meeting (${err?.message ?? 'unknown error'}). Please remove the meeting account manually.`);
        throw err;
      } finally {
        // Even if the SDK leave() call fails, drop our own "joined" bookkeeping
        // rather than leaving the bot permanently stuck thinking it's present —
        // a stuck true-positive is worse than a false negative here, since a
        // human asked us to leave and the meeting-ended webhook (or the next
        // poll sweep) will reconcile either way.
        transcription?.endSession(info.sdkMeetingId);
        meetingAgent?.clearRoom(info.roomId ?? roomId);
        state.markLeft(meetingId, { suppress });
      }
      await announce(roomId, 'Left the meeting.');
      log?.info?.(`[webex-meeting-join] left meeting=${meetingId} room=${roomId}`);
      return { left: true };
    });
  }

  // Rebuilds process-local state when the join response failed after Locus
  // accepted the browser device, or when the gateway restarted mid-meeting.
  // Both Webex REST and the Browser SDK must agree before a room command is
  // allowed to target a recovered meeting.
  async function recoverJoinedForRoom(roomId) {
    try {
      await browserRuntime.init(tokenStore.getToken());
      const sdkMeetings = await browserRuntime.syncActive();
      if (!Array.isArray(sdkMeetings) || !sdkMeetings.length) return null;

      const activeMeetings = await listActiveMeetings(tokenStore.meetingFetch, Date.now(), {
        lookbackMs: 24 * 60 * 60 * 1000,
      });
      const roomMeetings = activeMeetings.filter((meeting) => meeting.roomId === roomId);
      if (roomMeetings.length !== 1) return null;

      const meeting = roomMeetings[0];
      const { destination } = resolveDestination(meeting);
      const matchingSdk = findSdkMeetingFor(meeting, destination, sdkMeetings, { allowSole: true });
      if (!matchingSdk) return null;

      state.markJoined(meeting.id, {
        roomId,
        kind: classifyMeetingKind(meeting),
        destination,
        sdkMeetingId: matchingSdk.sdkMeetingId,
      });
      transcription?.startSession({ sdkMeetingId: matchingSdk.sdkMeetingId, roomId, meetingId: meeting.id });
      log?.warn?.(`[webex-meeting-join] recovered joined state meeting=${meeting.id} room=${roomId}`);
      return state.findJoinedByRoom(roomId);
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] joined-state recovery failed for room=${roomId}: ${err?.message ?? err}`);
      return null;
    }
  }

  // resource: meetings, event: started
  async function handleMeetingStarted(payload) {
    const meetingId = payload?.data?.id;
    if (!meetingId) {
      log?.warn?.('[webex-meeting-join] meetings/started webhook missing data.id, skipping');
      return;
    }
    const meeting = await fetchMeetingWithRetry(tokenStore.meetingFetch, meetingId);
    await tryJoin(meeting);
  }

  // resource: meetings, event: ended — cleans up state even if we never
  // actually joined (e.g. the meeting ended before our join attempt landed),
  // and self-heals if our own leave() call earlier failed to update state.
  async function handleMeetingEnded(payload) {
    const meetingId = payload?.data?.id;
    if (!meetingId) return;
    const info = state.joined.get(meetingId);
    state.joined.delete(meetingId);
    state.suppressed.delete(meetingId); // a new instance of this meeting id won't recur, so free the slot
    if (info) {
      transcription?.endSession(info.sdkMeetingId);
      meetingAgent?.clearRoom(info.roomId);
      log?.info?.(`[webex-meeting-join] meeting=${meetingId} ended, cleared local state`);
    }
  }

  // resource: messages, event: created — the "leave the meeting" command path.
  async function handleMessageCreated(payload) {
    const messageId = payload?.data?.id;
    if (!messageId) return;
    await ensureIdentities();
    const message = await webexFetch(cfg.botToken, `/messages/${encodeURIComponent(messageId)}`).catch(() => null);
    if (!message || message.personId === botId || message.personId === meetingPersonId) return;
    const commandText = stripMention(message.text, botName);
    const command = parseCommand(commandText);
    // Native @mentions remain the normal group-space control mechanism. A
    // plain bot-name prefix is accepted only when it leaves an exact meeting
    // command, so "openclaw leave meeting" works the same way as a native
    // mention without treating normal discussion as a command.
    const isPlainTextCommandAddress = command && commandText !== String(message.text ?? '').trim();
    if (!isAddressedToBot(message, botId) && !isPlainTextCommandAddress) return;
    if (!command) return;

    const current = state.findJoinedByRoom(message.roomId);
    if (command === 'status') {
      await announce(message.roomId, current
        ? 'I am currently in this space’s meeting. Say "leave meeting" to have me exit.'
        : 'No meeting currently joined for this space.');
      return;
    }
    if (command === 'leave') {
      const joined = current ?? await recoverJoinedForRoom(message.roomId);
      if (!joined) {
        await announce(message.roomId, 'There’s no meeting I’m currently in for this space.');
        return;
      }
      await tryLeave(joined.meetingId, { roomId: message.roomId, suppress: true });
    }
  }

  // Fallback for missed `meetings/started` webhooks (delivery failure,
  // subscription lapsed, gateway was down when the meeting started): scans
  // recently-active meetings visible to the meeting account and joins any
  // that are in-progress in a space we belong to and haven't been joined or
  // explicitly left already. Run once at startup and then on a timer.
  async function reconcile() {
    let active;
    try {
      active = await listActiveMeetings(tokenStore.meetingFetch);
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] reconciliation sweep failed: ${err?.message ?? err}`);
      return;
    }
    for (const meeting of active) {
      if (!meeting.id || !meeting.roomId) continue;
      try {
        await tryJoin(meeting, { announceFailure: false });
      } catch (err) {
        log?.warn?.(`[webex-meeting-join] reconciliation join failed for meeting=${meeting.id}: ${err?.message ?? err}`);
      }
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      reconcile().catch((err) => log?.warn?.(`[webex-meeting-join] poll sweep error: ${err?.message ?? err}`));
    }, cfg.pollIntervalMs);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function dispose() {
    stopPolling();
    transcription?.dispose();
    await browserRuntime.dispose();
  }

  return {
    start,
    handleMeetingStarted,
    handleMeetingEnded,
    handleMessageCreated,
    reconcile,
    startPolling,
    stopPolling,
    dispose,
    state, // exposed for tests only
  };
}

module.exports = { createOrchestrator };
