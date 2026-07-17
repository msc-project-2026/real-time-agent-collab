'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { webexFetch } = require('../webex/api');
const { registerMeetingJoiner } = require('../webex/meeting-joiner-bridge');

const WEBHOOK_PATH = '/webhooks/webex-meetings/';
const MAX_BODY_BYTES = 1024 * 1024;
const JOINED_REPLY = 'WEBEX_MEETING_JOINED';
const LEFT_REPLY = 'WEBEX_MEETING_LEFT';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConfig(env = process.env) {
  const accessToken = env.WEBEX_MEETING_ACCESS_TOKEN?.trim();
  const botToken = env.WEBEX_BOT_TOKEN?.trim();
  const webhookUrl = env.WEBEX_MEETING_WEBHOOK_URL?.trim();
  const webhookSecret = env.WEBEX_MEETING_WEBHOOK_SECRET?.trim();
  const missing = [
    !accessToken && 'WEBEX_MEETING_ACCESS_TOKEN',
    !botToken && 'WEBEX_BOT_TOKEN',
    !webhookUrl && 'WEBEX_MEETING_WEBHOOK_URL',
    !webhookSecret && 'WEBEX_MEETING_WEBHOOK_SECRET',
  ].filter(Boolean);
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  return { accessToken, botToken, webhookUrl, webhookSecret };
}

function verifyHmac(secret, rawBody, signature) {
  if (!signature) return false;
  const expected = Buffer.from(createHmac('sha1', secret).update(rawBody).digest('hex'));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function webhookDefinitions(webhookUrl, secret) {
  return [{
    name: 'OpenClaw Webex Meeting Started Handler',
    resource: 'meetings',
    event: 'started',
    targetUrl: webhookUrl,
    secret,
  }];
}

async function ensureMeetingWebhook(config) {
  const current = await webexFetch(config.accessToken, '/webhooks');
  const managedNames = new Set(webhookDefinitions(config.webhookUrl, config.webhookSecret).map((w) => w.name));
  await Promise.all((current?.items ?? [])
    .filter((webhook) => webhook.targetUrl === config.webhookUrl && managedNames.has(webhook.name))
    .map((webhook) => webexFetch(config.accessToken, `/webhooks/${webhook.id}`, { method: 'DELETE' })));
  for (const webhook of webhookDefinitions(config.webhookUrl, config.webhookSecret)) {
    await webexFetch(config.accessToken, '/webhooks', { method: 'POST', body: webhook });
  }
}

async function removeMeetingWebhook(config) {
  const current = await webexFetch(config.accessToken, '/webhooks');
  const managedNames = new Set(webhookDefinitions(config.webhookUrl, config.webhookSecret).map((w) => w.name));
  await Promise.all((current?.items ?? [])
    .filter((webhook) => webhook.targetUrl === config.webhookUrl && managedNames.has(webhook.name))
    .map((webhook) => webexFetch(config.accessToken, `/webhooks/${webhook.id}`, { method: 'DELETE' })));
}

function meetingIdFrom(payload) {
  return payload?.data?.id ?? payload?.data?.meetingId ?? payload?.data?.meetingSeriesId;
}

function meetingLink(meeting) {
  for (const key of ['webLink', 'joinLink', 'meetingLink']) {
    const value = meeting?.[key];
    if (typeof value === 'string' && value.startsWith('https://')) return value;
  }
  return null;
}

async function getMeetingWithRetry(accessToken, id, { attempts = 5, wait = sleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const meeting = await webexFetch(accessToken, `/meetings/${encodeURIComponent(id)}`);
      if (meetingLink(meeting)) return meeting;
      lastError = new Error('meeting link is not available yet');
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts - 1) await wait(1000 * (attempt + 1));
  }
  throw lastError ?? new Error('could not retrieve meeting details');
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
    ['/meeting', 'status'],
    ['/meeting status', 'status'],
    ['/meeting leave', 'leave'],
    ['/leave meeting', 'leave'],
    ['leave meeting', 'leave'],
    ['leave the meeting', 'leave'],
    ['/meeting join', 'join'],
    ['/join meeting', 'join'],
    ['join meeting', 'join'],
    ['join the meeting', 'join'],
  ]);
  return actions.get(normalized) ?? null;
}

class MeetingJoiner {
  constructor({ runtime, logger, config, wait = sleep }) {
    this.runtime = runtime;
    this.logger = logger;
    this.config = config;
    this.wait = wait;
    this.activeByRoom = new Map();
    this.suppressedMeetingIds = new Set();
    this.inFlight = new Map();
  }

  async announce(roomId, markdown) {
    await webexFetch(this.config.botToken, '/messages', {
      method: 'POST', body: { roomId, markdown },
    });
  }

  async join(record) {
    if (this.suppressedMeetingIds.has(record.id)) return { skipped: 'left-by-user' };
    if (this.inFlight.has(record.id)) return this.inFlight.get(record.id);
    const task = (async () => {
      const reply = await dispatchBrowserTask(
        this.runtime,
        buildJoinPrompt(record.link),
        makeSessionKey('join', record.id),
      );
      if (!isExactReply(reply, JOINED_REPLY)) {
        throw new Error('browser agent did not confirm joining the meeting');
      }
      if (this.suppressedMeetingIds.has(record.id)) return { skipped: 'left-by-user' };
      this.activeByRoom.set(record.roomId, { ...record, joined: true });
      await this.announce(record.roomId, 'joined the meeting');
      this.logger?.info?.(`[webex-meeting-joiner] joined meeting=${record.id} room=${record.roomId}`);
      return { joined: true };
    })();
    this.inFlight.set(record.id, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(record.id);
    }
  }

  async processMeetingStarted(payload) {
    if (payload?.resource !== 'meetings' || payload?.event !== 'started') return false;
    const id = meetingIdFrom(payload);
    if (!id || this.suppressedMeetingIds.has(id)) return false;
    const meeting = await getMeetingWithRetry(this.config.accessToken, id, { wait: this.wait });
    const roomId = meeting.roomId ?? payload.data?.roomId;
    const link = meetingLink(meeting);
    if (!roomId || !link) return false;
    if (!await isRoomMember(this.config.botToken, roomId, this.config.botId)) return false;
    if (payload.actorId && !await isRoomMember(this.config.botToken, roomId, payload.actorId)) return false;
    return this.join({ id, roomId, link, title: meeting.title ?? 'Webex meeting' });
  }

  async currentMeetingInRoom(roomId) {
    const active = this.activeByRoom.get(roomId);
    if (active) return active;
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const query = new URLSearchParams({ roomId, from, to });
    const result = await webexFetch(this.config.accessToken, `/meetings?${query}`);
    const meeting = (result?.items ?? []).find((item) => meetingLink(item));
    if (!meeting) return null;
    return { id: meeting.id, roomId, link: meetingLink(meeting), title: meeting.title ?? 'Webex meeting' };
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
    this.activeByRoom.set(roomId, { ...meeting, joined: false, left: true });
    await this.announce(roomId, 'left the meeting');
    this.logger?.info?.(`[webex-meeting-joiner] left meeting=${meeting.id} room=${roomId}`);
    return true;
  }
}

function createWebhookHandler(joiner, config) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405; res.setHeader('Allow', 'POST'); res.end('Method Not Allowed'); return true;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { res.statusCode = 413; res.end('Payload Too Large'); return true; }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (!verifyHmac(config.webhookSecret, raw, req.headers['x-spark-signature'])) {
      res.statusCode = 401; res.end('Unauthorized'); return true;
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { res.statusCode = 400; res.end('Bad Request'); return true; }
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
    joiner.processMeetingStarted(payload).catch((err) =>
      joiner.logger?.error?.(`[webex-meeting-joiner] meeting event failed: ${err?.message ?? err}`));
    return true;
  };
}

function register(api) {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    api.logger?.warn?.(`[webex-meeting-joiner] disabled: ${err.message}`);
    return;
  }
  const joiner = new MeetingJoiner({ runtime: api.runtime, logger: api.logger, config });
  api.registerHttpRoute({ path: WEBHOOK_PATH, auth: 'plugin', match: 'prefix', handler: createWebhookHandler(joiner, config) });
  const unregister = registerMeetingJoiner(joiner);
  api.on('gateway_start', async () => {
    const bot = await webexFetch(config.botToken, '/people/me');
    joiner.config.botId = bot.id;
    await ensureMeetingWebhook(config);
    api.logger?.info?.('[webex-meeting-joiner] meeting-start webhook registered');
  }, { timeoutMs: 30000 });
  api.on('gateway_stop', async () => {
    unregister();
    await removeMeetingWebhook(config).catch((err) =>
      api.logger?.warn?.(`[webex-meeting-joiner] webhook cleanup failed: ${err?.message ?? err}`));
  }, { timeoutMs: 30000 });
}

module.exports = register;
module.exports.default = register;
module.exports.MeetingJoiner = MeetingJoiner;
module.exports.buildJoinPrompt = buildJoinPrompt;
module.exports.buildLeavePrompt = buildLeavePrompt;
module.exports.createWebhookHandler = createWebhookHandler;
module.exports.ensureMeetingWebhook = ensureMeetingWebhook;
module.exports.getConfig = getConfig;
module.exports.getMeetingWithRetry = getMeetingWithRetry;
module.exports.isExactReply = isExactReply;
module.exports.meetingLink = meetingLink;
module.exports.commandAction = commandAction;
