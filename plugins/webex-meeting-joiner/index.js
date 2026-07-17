'use strict';

const { webexFetch } = require('../webex/api');
const { registerMeetingJoiner } = require('../webex/meeting-joiner-bridge');

const JOINED_REPLY = 'WEBEX_MEETING_JOINED';
const LEFT_REPLY = 'WEBEX_MEETING_LEFT';
const DEFAULT_POLL_INTERVAL_MS = 15_000;

function getConfig(env = process.env) {
  // Reuse the existing Webex OAuth identity when it is the dedicated meeting
  // user. WEBEX_MEETING_ACCESS_TOKEN is available when deployments keep the
  // meeting account separate from the channel's OAuth identity.
  const accessToken = env.WEBEX_MEETING_ACCESS_TOKEN?.trim() ?? env.WEBEX_ACCESS_TOKEN?.trim();
  const botToken = env.WEBEX_BOT_TOKEN?.trim();
  const pollIntervalMs = Number(env.WEBEX_MEETING_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  const missing = [
    !accessToken && 'WEBEX_MEETING_ACCESS_TOKEN (or WEBEX_ACCESS_TOKEN)',
    !botToken && 'WEBEX_BOT_TOKEN',
  ].filter(Boolean);
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  return {
    accessToken,
    botToken,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs >= 5_000
      ? pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS,
  };
}

function meetingLink(meeting) {
  for (const key of ['webLink', 'joinLink', 'meetingLink']) {
    const value = meeting?.[key];
    if (typeof value === 'string' && value.startsWith('https://')) return value;
  }
  return null;
}

function isStartedMeeting(meeting) {
  const type = String(meeting?.meetingType ?? '').toLowerCase();
  const state = String(meeting?.state ?? meeting?.status ?? '').toLowerCase();
  return type === 'meeting' || ['inprogress', 'started', 'active'].includes(state) ||
    Boolean(meeting?.actualStart && !meeting?.actualEnd);
}

async function listVisibleMeetings(accessToken, now = Date.now()) {
  // A started meeting is represented by a `meeting` record in Webex. The
  // window also includes scheduled records, which lets the same account see
  // forthcoming invitations without confusing them for a meeting to join.
  const query = new URLSearchParams({
    from: new Date(now - 10 * 60 * 1000).toISOString(),
    to: new Date(now + 60 * 60 * 1000).toISOString(),
    max: '100',
  });
  const result = await webexFetch(accessToken, `/meetings?${query}`);
  return result?.items ?? [];
}

async function getMeeting(accessToken, id) {
  return webexFetch(accessToken, `/meetings/${encodeURIComponent(id)}`);
}

async function isRoomMember(token, roomId, personId) {
  if (!roomId || !personId) return false;
  const query = new URLSearchParams({ roomId, personId });
  const result = await webexFetch(token, `/memberships?${query}`);
  return Boolean(result?.items?.length);
}

function isExactReply(reply, expected) {
  return String(reply ?? '').split('\n').some((line) => line.trim() === expected);
}

function buildJoinPrompt(link) {
  return `Join this Webex meeting using the existing signed-in Webex session: ${link}

Use only the browser tool, always targeting the gateway-managed Brave browser (target="host", profile="openclaw"). Navigate to the link, inspect the actual page, and use the available Webex controls to join from the browser. Before joining, make sure microphone and camera are both off. Do not use system audio. If a native-app prompt appears, stay in the browser. Reason from the visible page and press the controls required for this specific meeting; do not use scripts, page source, regex, or a pre-recorded click sequence.

If the meeting requires a password, CAPTCHA, MFA, host admission, or another user action, stop without trying to bypass it. Once the participant has actually entered the meeting with microphone and camera off, respond exactly ${JOINED_REPLY}. Otherwise respond exactly WEBEX_MEETING_JOIN_BLOCKED.`;
}

function buildLeavePrompt() {
  return `Use only the browser tool, always targeting the gateway-managed Brave browser (target="host", profile="openclaw"). Inspect the current Webex meeting page and leave the meeting through its visible controls. Do not navigate to another meeting, change browser sign-in state, or interact with any chat. When the meeting has been exited, respond exactly ${LEFT_REPLY}. If no active meeting is open or the page cannot be left, respond exactly WEBEX_MEETING_LEAVE_BLOCKED.`;
}

async function dispatchBrowserTask(runtime, prompt, sessionKey) {
  const dispatch = runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) throw new Error('OpenClaw agent pipeline dispatch unavailable');
  const replies = [];
  let dispatchError;
  const now = new Date().toISOString();
  await dispatch({
    ctx: {
      Body: prompt, RawBody: prompt, CommandBody: prompt,
      From: 'webex-meeting-joiner', To: 'webex-meeting-joiner',
      SessionKey: sessionKey, AccountId: 'default', ChatType: 'direct',
      SenderName: 'Webex Meeting Joiner', SenderId: 'webex-meeting-joiner',
      Provider: 'webex-meeting-joiner', Surface: 'webex-meeting-joiner',
      MessageSid: `${sessionKey}:${Date.now()}`, Timestamp: now,
      OriginatingChannel: 'webex-meeting-joiner', OriginatingTo: 'webex-meeting-joiner',
      IsMentioned: true,
    },
    cfg: runtime.config?.current?.() ?? {},
    dispatcherOptions: {
      deliver: async (out) => {
        const text = out?.text ?? out?.markdown;
        if (text) replies.push(String(text));
      },
      onError: (err) => { dispatchError = err instanceof Error ? err : new Error(String(err)); },
    },
    replyOptions: {},
  });
  if (dispatchError) throw dispatchError;
  return replies.join('\n');
}

function makeSessionKey(action, meetingId) {
  return `agent:main:webex-meeting-joiner:${action}:${Buffer.from(String(meetingId)).toString('base64url')}`;
}

function commandAction(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  const actions = new Map([
    ['/meeting', 'status'], ['/meeting status', 'status'],
    ['/meeting leave', 'leave'], ['/leave meeting', 'leave'],
    ['leave meeting', 'leave'], ['leave the meeting', 'leave'],
    ['/meeting join', 'join'], ['/join meeting', 'join'],
    ['join meeting', 'join'], ['join the meeting', 'join'],
  ]);
  return actions.get(normalized) ?? null;
}

class MeetingJoiner {
  constructor({ runtime, logger, config }) {
    this.runtime = runtime;
    this.logger = logger;
    this.config = config;
    this.activeByRoom = new Map();
    this.joinedMeetingIds = new Set();
    this.suppressedMeetingIds = new Set();
    this.inFlight = new Map();
    this.scanPromise = null;
  }

  async announce(roomId, markdown) {
    await webexFetch(this.config.botToken, '/messages', { method: 'POST', body: { roomId, markdown } });
  }

  async join(record) {
    if (this.suppressedMeetingIds.has(record.id)) return { skipped: 'left-by-user' };
    if (this.joinedMeetingIds.has(record.id)) return { skipped: 'already-joined' };
    if (this.inFlight.has(record.id)) return this.inFlight.get(record.id);
    const task = (async () => {
      const reply = await dispatchBrowserTask(this.runtime, buildJoinPrompt(record.link), makeSessionKey('join', record.id));
      if (!isExactReply(reply, JOINED_REPLY)) throw new Error('browser agent did not confirm joining the meeting');
      if (this.suppressedMeetingIds.has(record.id)) return { skipped: 'left-by-user' };
      this.joinedMeetingIds.add(record.id);
      this.activeByRoom.set(record.roomId, { ...record, joined: true });
      await this.announce(record.roomId, 'joined the meeting');
      this.logger?.info?.(`[webex-meeting-joiner] joined meeting=${record.id} room=${record.roomId}`);
      return { joined: true };
    })();
    this.inFlight.set(record.id, task);
    try { return await task; } finally { this.inFlight.delete(record.id); }
  }

  async currentMeetingInRoom(roomId) {
    const active = this.activeByRoom.get(roomId);
    if (active) return active;
    const meetings = await listVisibleMeetings(this.config.accessToken);
    const candidate = meetings.find((meeting) => meeting.roomId === roomId && isStartedMeeting(meeting));
    if (!candidate?.id) return null;
    const meeting = await getMeeting(this.config.accessToken, candidate.id);
    const link = meetingLink(meeting);
    return link ? { id: meeting.id, roomId, link, title: meeting.title ?? 'Webex meeting' } : null;
  }

  async scanActiveMeetings() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      const visibleMeetings = await listVisibleMeetings(this.config.accessToken);
      const started = visibleMeetings.filter((meeting) => isStartedMeeting(meeting) && meeting.id && meeting.roomId);
      for (const candidate of started) {
        try {
          if (this.suppressedMeetingIds.has(candidate.id) || this.joinedMeetingIds.has(candidate.id)) continue;
          if (!await isRoomMember(this.config.botToken, candidate.roomId, this.config.botId)) continue;
          const meeting = await getMeeting(this.config.accessToken, candidate.id);
          const link = meetingLink(meeting);
          if (!link) continue;
          await this.join({ id: meeting.id, roomId: candidate.roomId, link, title: meeting.title ?? 'Webex meeting' });
        } catch (err) {
          this.logger?.warn?.(`[webex-meeting-joiner] scan candidate failed: ${err?.message ?? err}`);
        }
      }
    })();
    try { return await this.scanPromise; } finally { this.scanPromise = null; }
  }

  async handleCommand({ text, roomId }) {
    const action = commandAction(text);
    if (!action) return false;
    if (action === 'status') {
      const active = this.activeByRoom.get(roomId);
      await this.announce(roomId, active?.joined
        ? 'I am currently in this space’s meeting. Use `/meeting leave` to exit.'
        : 'No meeting is currently joined for this space. Use `/meeting join` to join the current meeting.');
      return true;
    }
    const meeting = await this.currentMeetingInRoom(roomId);
    if (!meeting) {
      await this.announce(roomId, 'There is no current Webex meeting in this space.');
      return true;
    }
    if (action === 'join') {
      this.suppressedMeetingIds.delete(meeting.id);
      await this.join(meeting);
      return true;
    }
    this.suppressedMeetingIds.add(meeting.id);
    const reply = await dispatchBrowserTask(this.runtime, buildLeavePrompt(), makeSessionKey('leave', meeting.id));
    if (!isExactReply(reply, LEFT_REPLY)) throw new Error('browser agent did not confirm leaving the meeting');
    this.joinedMeetingIds.delete(meeting.id);
    this.activeByRoom.set(roomId, { ...meeting, joined: false, left: true });
    await this.announce(roomId, 'left the meeting');
    this.logger?.info?.(`[webex-meeting-joiner] left meeting=${meeting.id} room=${roomId}`);
    return true;
  }
}

function register(api) {
  let config;
  try { config = getConfig(); } catch (err) {
    api.logger?.warn?.(`[webex-meeting-joiner] disabled: ${err.message}`);
    return;
  }
  const joiner = new MeetingJoiner({ runtime: api.runtime, logger: api.logger, config });
  const unregister = registerMeetingJoiner(joiner);
  let pollTimer = null;
  api.on('gateway_start', async () => {
    const bot = await webexFetch(config.botToken, '/people/me');
    joiner.config.botId = bot.id;
    const poll = () => joiner.scanActiveMeetings().catch((err) =>
      api.logger?.warn?.(`[webex-meeting-joiner] polling failed: ${err?.message ?? err}`));
    poll();
    pollTimer = setInterval(poll, config.pollIntervalMs);
    api.logger?.info?.(`[webex-meeting-joiner] polling visible meetings every ${config.pollIntervalMs}ms`);
  }, { timeoutMs: 30000 });
  api.on('gateway_stop', () => {
    unregister();
    if (pollTimer) clearInterval(pollTimer);
  });
}

module.exports = register;
module.exports.default = register;
module.exports.MeetingJoiner = MeetingJoiner;
module.exports.buildJoinPrompt = buildJoinPrompt;
module.exports.buildLeavePrompt = buildLeavePrompt;
module.exports.commandAction = commandAction;
module.exports.getConfig = getConfig;
module.exports.isExactReply = isExactReply;
module.exports.isStartedMeeting = isStartedMeeting;
module.exports.listVisibleMeetings = listVisibleMeetings;
module.exports.meetingLink = meetingLink;
