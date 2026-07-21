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

function createOrchestrator({ cfg, tokenStore, browserRuntime, log }) {
  const state = new (require('./state').MeetingState)();
  let botId = null;
  let meetingPersonId = null;
  let pollTimer = null;

  async function announce(roomId, markdown) {
    try {
      await webexFetch(cfg.botToken, '/messages', { method: 'POST', body: { roomId, markdown } });
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] failed to post to room ${roomId}: ${err?.message ?? err}`);
    }
  }

  async function start() {
    const bot = await webexFetch(cfg.botToken, '/people/me');
    botId = bot.id;
    const me = await tokenStore.meetingFetch('/people/me');
    meetingPersonId = me.id;
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
  async function tryJoin(meeting) {
    const meetingId = meeting?.id;
    const roomId = meeting?.roomId;
    if (!meetingId) return { skipped: 'no-id' };
    if (state.isSuppressed(meetingId)) return { skipped: 'suppressed' };
    if (state.isJoined(meetingId)) return { skipped: 'already-joined' };
    if (!roomId) return { skipped: 'no-room' }; // not a space meeting we can post into

    return state.withLock(meetingId, async () => {
      if (state.isSuppressed(meetingId) || state.isJoined(meetingId)) return { skipped: 'race' };

      const member = await isRoomMember(tokenStore.meetingFetch, roomId, meetingPersonId).catch(() => false);
      if (!member) return { skipped: 'not-a-member' };

      const { destination, type } = resolveDestination(meeting);
      const kind = classifyMeetingKind(meeting);

      try {
        await browserRuntime.join(destination, type);
      } catch (err) {
        log?.error?.(`[webex-meeting-join] join failed for meeting=${meetingId}: ${err?.message ?? err}`);
        await announce(roomId, `I couldn't join the meeting that just started (${err?.message ?? 'unknown error'}). Please join manually if needed.`);
        throw err;
      }

      state.markJoined(meetingId, { roomId, kind });
      const label = kind === 'instant' ? 'the meeting that just started' : 'the scheduled meeting';
      await announce(roomId, `Joined ${label}${meeting.title ? ` (“${meeting.title}”)` : ''}. Say "leave meeting" and I'll step out.`);
      log?.info?.(`[webex-meeting-join] joined meeting=${meetingId} room=${roomId}`);
      return { joined: true };
    });
  }

  async function tryLeave(meetingId, { roomId, suppress = true } = {}) {
    return state.withLock(meetingId, async () => {
      if (!state.isJoined(meetingId)) return { skipped: 'not-joined' };
      try {
        await browserRuntime.leave(meetingId);
      } finally {
        // Even if the SDK leave() call fails, drop our own "joined" bookkeeping
        // rather than leaving the bot permanently stuck thinking it's present —
        // a stuck true-positive is worse than a false negative here, since a
        // human asked us to leave and the meeting-ended webhook (or the next
        // poll sweep) will reconcile either way.
        state.markLeft(meetingId, { suppress });
      }
      await announce(roomId, 'Left the meeting.');
      log?.info?.(`[webex-meeting-join] left meeting=${meetingId} room=${roomId}`);
      return { left: true };
    });
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
    if (info) log?.info?.(`[webex-meeting-join] meeting=${meetingId} ended, cleared local state`);
  }

  // resource: messages, event: created — the "leave the meeting" command path.
  async function handleMessageCreated(payload) {
    const messageId = payload?.data?.id;
    if (!messageId) return;
    const message = await webexFetch(cfg.botToken, `/messages/${encodeURIComponent(messageId)}`).catch(() => null);
    if (!message || message.personId === botId || message.personId === meetingPersonId) return;
    if (!isAddressedToBot(message, botId)) return;

    const command = parseCommand(stripMention(message.text));
    if (!command) return;

    const current = state.findJoinedByRoom(message.roomId);
    if (command === 'status') {
      await announce(message.roomId, current
        ? 'I am currently in this space’s meeting. Say "leave meeting" to have me exit.'
        : 'No meeting currently joined for this space.');
      return;
    }
    if (command === 'leave') {
      if (!current) {
        await announce(message.roomId, 'There’s no meeting I’m currently in for this space.');
        return;
      }
      await tryLeave(current.meetingId, { roomId: message.roomId, suppress: true });
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
        await tryJoin(meeting);
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
