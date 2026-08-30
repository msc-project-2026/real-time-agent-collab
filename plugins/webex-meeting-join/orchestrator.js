// Wires webhook events, meeting-resource resolution, join/leave state, and
// the headless-browser SDK runtime together. This module is the testable
// core: `browserRuntime` is injected so tests can supply a fake one instead
// of driving a real headless Chromium + Webex meeting (see
// orchestrator.test.cjs).
'use strict';

const { webexFetch } = require('./api');
const { parseCommand, isJoinPolicyCommand, isExplicitSlashCommand, isAddressedToBot, stripMention } = require('./commands');
const {
  classifyMeetingKind,
  resolveDestination,
  fetchMeetingWithRetry,
  isActiveMeeting,
  isRoomMember,
  listActiveMeetings,
} = require('./meetings');
const { createSpacePrefs } = require('./space-prefs');

const MESSAGE_COMMAND_DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUPED_MESSAGE_IDS = 1000;

function createOrchestrator({
  cfg,
  tokenStore,
  browserRuntime,
  log,
  transcription = null,
  meetingAgent = null,
  meetingMinutes = null,
  spacePrefs = null,
}) {
  const state = new (require('./state').MeetingState)();
  const prefs = spacePrefs ?? createSpacePrefs({ log });
  let botId = null;
  let botName = null;
  let meetingPersonId = null;
  let pollTimer = null;
  let identityPromise = null;
  const handledMessageIds = new Map();

  function reserveMessageId(messageId) {
    const now = Date.now();

    for (const [id, expiresAt] of handledMessageIds) {
      if (expiresAt <= now) handledMessageIds.delete(id);
    }

    if (handledMessageIds.has(messageId)) return false;

    handledMessageIds.set(messageId, now + MESSAGE_COMMAND_DEDUP_TTL_MS);
    if (handledMessageIds.size > MAX_DEDUPED_MESSAGE_IDS) {
      handledMessageIds.delete(handledMessageIds.keys().next().value);
    }

    return true;
  }

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

  async function startLiveTranscription({ sdkMeetingId, meetingId, roomId, destination }) {
    transcription?.startSession({ sdkMeetingId, roomId, meetingId });
    if (cfg.transcription?.provider !== 'webex') return;
    await browserRuntime.startTranscription({ sdkMeetingId, meetingId, destination }).catch((err) => {
      log?.warn?.(`[webex-meeting-join] Webex live transcription unavailable for meeting=${meetingId}: ${err?.message ?? err}`);
    });
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
  // `force` is the explicit-user-request path (`/meeting join`): it overrides
  // both the per-meeting "leave" suppression and the space's durable opt-out
  // for THIS meeting only. Neither piece of policy state is written, so future
  // meetings are unaffected (markJoined clears the suppression flag on
  // success, which is what "rejoin after being told to leave" needs anyway).
  async function tryJoin(meeting, { announceFailure = true, force = false } = {}) {
    const meetingId = meeting?.id;
    const roomId = meeting?.roomId;
    if (!meetingId) return { skipped: 'no-id' };
    if (!force && state.isSuppressed(meetingId)) return { skipped: 'suppressed' };
    if (state.isJoined(meetingId)) return { skipped: 'already-joined' };
    if (!roomId) return { skipped: 'no-room' }; // not a space meeting we can post into
    // Durable per-space opt-out (natural-language "never join meetings").
    // Checked before lock so reconcile/poll stays cheap when a space is opted out.
    if (!force && prefs.shouldNeverJoin(roomId)) return { skipped: 'space-opt-out' };

    return state.withLock(meetingId, async () => {
      if (state.isJoined(meetingId)) return { skipped: 'race' };
      if (!force && (state.isSuppressed(meetingId) || prefs.shouldNeverJoin(roomId))) return { skipped: 'race' };

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
        await startLiveTranscription({ sdkMeetingId, roomId, meetingId, destination });
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
          await startLiveTranscription({
            sdkMeetingId: recovered.sdkMeetingId,
            roomId,
            meetingId,
            destination,
          });
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
      await startLiveTranscription({
        sdkMeetingId: matchingSdk.sdkMeetingId,
        roomId,
        meetingId: meeting.id,
        destination,
      });
      log?.warn?.(`[webex-meeting-join] recovered joined state meeting=${meeting.id} room=${roomId}`);
      return state.findJoinedByRoom(roomId);
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] joined-state recovery failed for room=${roomId}: ${err?.message ?? err}`);
      return null;
    }
  }

  // Candidate meetings for an explicit `/meeting join` in this space.
  //
  // A `meetings/started` webhook already named the meeting, so prefer what we
  // recorded there — it works for an instant (ad-hoc) meeting, which the
  // scheduled-meeting list query cannot see, and for a meeting that started
  // long enough ago to have fallen out of the list window. The list sweep
  // stays as the fallback for a webhook we never received.
  async function resolveJoinCandidates(roomId) {
    const known = await Promise.all(
      state.liveMeetingIdsForRoom(roomId).map(async (meetingId) => {
        const meeting = await fetchMeetingWithRetry(tokenStore.meetingFetch, meetingId, { attempts: 1 })
          .catch(() => null);
        // A meeting that ended without an `ended` webhook must not be offered
        // as a join target — drop it and let the list sweep have its say.
        if (!meeting || !isActiveMeeting(meeting) || meeting.roomId !== roomId) {
          state.forgetLive(meetingId);
          return null;
        }
        return meeting;
      })
    );
    const live = known.filter(Boolean);
    if (live.length) return live;

    // Widened window: unlike the poll sweep, this is a human asking about a
    // meeting they know is running, which may have started hours ago.
    const active = await listActiveMeetings(tokenStore.meetingFetch, Date.now(), {
      lookbackMs: 24 * 60 * 60 * 1000,
    });
    return active.filter((meeting) => meeting.roomId === roomId);
  }

  // resource: meetings, event: started
  async function handleMeetingStarted(payload) {
    const meetingId = payload?.data?.id;
    if (!meetingId) {
      log?.warn?.('[webex-meeting-join] meetings/started webhook missing data.id, skipping');
      return;
    }
    const meeting = await fetchMeetingWithRetry(tokenStore.meetingFetch, meetingId);
    await meetingMinutes?.rememberMeeting(meeting).catch((err) =>
      log?.warn?.(`[webex-meeting-join] failed to remember meeting=${meetingId} for minutes: ${err?.message ?? err}`)
    );
    // Remember it before deciding whether to join: when the space is opted
    // out we skip the join, and this is the only record that would let a
    // later `/meeting join` name the meeting.
    state.markLive(meeting?.id ?? meetingId, meeting?.roomId);
    await tryJoin(meeting);
  }

  // resource: meetings, event: ended — cleans up state even if we never
  // actually joined (e.g. the meeting ended before our join attempt landed),
  // and self-heals if our own leave() call earlier failed to update state.
  async function handleMeetingEnded(payload) {
    const meetingId = payload?.data?.id;
    if (!meetingId) return;
    const info = state.joined.get(meetingId);
    const roomId = info?.roomId ?? state.live.get(meetingId) ?? null;
    state.joined.delete(meetingId);
    state.forgetLive(meetingId);
    state.suppressed.delete(meetingId); // a new instance of this meeting id won't recur, so free the slot
    if (info) {
      if (cfg.transcription?.provider === 'webex') {
        await browserRuntime.stopTranscription({
          meetingId,
          sdkMeetingId: info.sdkMeetingId,
          destination: info.destination,
        }).catch(() => {});
      }
      transcription?.endSession(info.sdkMeetingId);
      meetingAgent?.clearRoom(info.roomId);
      log?.info?.(`[webex-meeting-join] meeting=${meetingId} ended, cleared local state`);
    }
    await meetingMinutes?.handleMeetingEnded({ meetingId, roomId }).catch((err) =>
      log?.warn?.(`[webex-meeting-join] failed to schedule transcript recovery meeting=${meetingId}: ${err?.message ?? err}`)
    );
  }

  // Primary meeting-minutes path: Webex emits this only after the post-meeting
  // transcript asset has been created. The webhook router has already ACKed.
  async function handleTranscriptCreated(payload) {
    if (!meetingMinutes) return;
    await meetingMinutes.handleTranscriptCreated(payload);
  }

  // resource: messages, event: created — leave / status / per-space join policy.
  async function handleMessageCreatedOnce(payload) {
    const messageId = payload?.data?.id;
    if (!messageId) return;
    await ensureIdentities();
    // Fetched with the meeting-account token: the webhook is registered under
    // that account (bots never receive un-@mentioned group messages), and a
    // bot token can't read messages it wasn't mentioned in either.
    const message = await tokenStore.meetingFetch(`/messages/${encodeURIComponent(messageId)}`).catch(() => null);
    if (!message || message.personId === botId || message.personId === meetingPersonId) return;
    const commandText = stripMention(message.text, botName);
    const command = parseCommand(commandText);
    // Native @mentions remain the normal group-space control mechanism. A
    // plain bot-name prefix is accepted only when it leaves an exact meeting
    // command, so "openclaw leave meeting" works the same way as a native
    // mention without treating normal discussion as a command.
    //
    // Join-policy utterances ("the agent should never join meetings") are
    // themselves instructions about the bot, so they are accepted without an
    // @mention when the whole message parses as never-join / allow-join.
    const isPlainTextCommandAddress = command && commandText !== String(message.text ?? '').trim();
    const addressed =
      isAddressedToBot(message, botId) ||
      isPlainTextCommandAddress ||
      isJoinPolicyCommand(command) ||
      isExplicitSlashCommand(commandText);
    if (!addressed || !command) return;

    const roomId = message.roomId;
    const current = state.findJoinedByRoom(roomId);
    const neverJoin = prefs.shouldNeverJoin(roomId);

    if (command === 'status') {
      const presence = current
        ? 'I am currently in this space’s meeting. Say "leave meeting" to have me exit.'
        : 'No meeting currently joined for this space.';
      const policy = neverJoin
        ? ' Auto-join is **off** for this space (I will not join future meetings). Say "you can join meetings" to turn it back on, or `/meeting join` to bring me into the current meeting just this once.'
        : ' Auto-join is **on** for this space. Say "never join meetings" if you want me to stop joining.';
      await announce(roomId, presence + policy);
      return;
    }

    if (command === 'never-join') {
      if (!neverJoin) {
        prefs.setNeverJoin(roomId, true, { updatedBy: message.personId });
      }
      const joined = current ?? await recoverJoinedForRoom(roomId);
      if (joined) {
        await tryLeave(joined.meetingId, { roomId, suppress: true });
      }
      await announce(
        roomId,
        neverJoin && !joined
          ? 'Auto-join is already off for this space — I will not join meetings here.'
          : 'Got it — I will not join meetings in this space. Say "you can join meetings" anytime to turn auto-join back on, or `/meeting join` to bring me into a specific meeting just this once.'
      );
      return;
    }

    if (command === 'allow-join') {
      if (neverJoin) {
        prefs.setNeverJoin(roomId, false, { updatedBy: message.personId });
      }
      await announce(
        roomId,
        neverJoin
          ? 'Auto-join is back on for this space — I will join meetings here when they go live.'
          : 'Auto-join is already on for this space — I will join meetings when they go live.'
      );
      return;
    }

    // One-off, user-requested join of the meeting currently in progress.
    // Overrides the space opt-out and any earlier "leave" suppression for
    // this meeting only; the durable policy is not touched.
    if (command === 'join') {
      if (current) {
        await announce(roomId, 'I’m already in this space’s meeting. Say "leave meeting" to have me exit.');
        return;
      }
      let roomMeetings;
      try {
        roomMeetings = await resolveJoinCandidates(roomId);
      } catch (err) {
        await announce(roomId, `I couldn't look up this space's meetings (${err?.message ?? 'unknown error'}). Please try again.`);
        return;
      }
      if (!roomMeetings.length) {
        await announce(roomId, 'I couldn’t find a meeting in progress for this space.');
        return;
      }
      // Same caution as recoverJoinedForRoom: with several concurrent
      // candidates, refuse to guess which one was meant.
      if (roomMeetings.length > 1) {
        await announce(roomId, 'I found more than one in-progress meeting for this space, so I don’t know which one to join.');
        return;
      }

      const result = await tryJoin(roomMeetings[0], { force: true });
      if (result?.skipped === 'not-a-member') {
        await announce(roomId, 'I can’t join: my meeting account isn’t a member of this space.');
      } else if (result?.skipped === 'already-joined' || result?.skipped === 'race') {
        await announce(roomId, 'I’m already in this space’s meeting.');
      } else if (result?.joined && neverJoin) {
        await announce(roomId, 'Auto-join stays **off** for this space — I joined this meeting only because you asked.');
      }
      return;
    }

    if (command === 'leave') {
      const joined = current ?? await recoverJoinedForRoom(roomId);
      if (!joined) {
        await announce(roomId, 'There’s no meeting I’m currently in for this space.');
        return;
      }
      await tryLeave(joined.meetingId, { roomId, suppress: true });
    }
  }

  async function handleMessageCreated(payload) {
    const messageId = payload?.data?.id;
    if (!messageId) return;
    if (!reserveMessageId(messageId)) {
      log?.info?.(`[webex-meeting-join] ignoring duplicate message webhook id=${messageId}`);
      return;
    }

    try {
      await handleMessageCreatedOnce(payload);
    } catch (err) {
      // Preserve redelivery as a retry path when the first attempt fails.
      handledMessageIds.delete(messageId);
      throw err;
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
      // Recorded even when the join is skipped (opted-out space), so a later
      // `/meeting join` can still find a meeting whose started-webhook we
      // missed and which may since have aged out of the list window.
      state.markLive(meeting.id, meeting.roomId);
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
    meetingMinutes?.dispose();
    await browserRuntime.dispose();
  }

  return {
    start,
    handleMeetingStarted,
    handleMeetingEnded,
    handleTranscriptCreated,
    handleMessageCreated,
    reconcile,
    startPolling,
    stopPolling,
    dispose,
    state, // exposed for tests only
    spacePrefs: prefs, // exposed for tests only
  };
}

module.exports = { createOrchestrator };
