'use strict';

// Bridges live meeting-transcription events into the same speak/silence
// pipeline used for chat messages (gate.js, context.js, debounce.js, lull.js,
// prefs.js, audit.js) and the same reply-dispatch path used by inbound.js.
//
// Call ingestTranscript() once per transcription event received from
// meeting-runtime.js. Interim segments are dropped — only 'final' segments
// are treated as a "message", since interim text is too unstable to gate on.

const { webexFetch } = require('./api');
const { scoreMessage } = require('./gate');
const { recordMessage: lullRecord, waitForLull, getLastSeen } = require('./lull');
const { recordMessage: ctxRecord, getRecentMessages } = require('./context');
const { tryAccept } = require('./debounce');
const { logDecision } = require('./audit');
const { buildMsgBody } = require('./send');
const prefs = require('./prefs');
const { resolveRoom } = require('./roomMap');

let pluginRuntime = null;
function setRuntime(r) {
  pluginRuntime = r;
}

// Map<personId, { name, fetchedAt }> — avoid a /people lookup per transcript chunk
const nameCache = new Map();
const NAME_CACHE_TTL_MS = 30 * 60 * 1000;

async function resolveSenderName(token, personId) {
  const cached = nameCache.get(personId);
  if (cached && Date.now() - cached.fetchedAt < NAME_CACHE_TTL_MS) return cached.name;

  try {
    const person = await webexFetch(token, `/people/${personId}`);
    const name = person?.displayName ?? person?.emails?.[0] ?? personId;
    nameCache.set(personId, { name, fetchedAt: Date.now() });
    return name;
  } catch {
    return personId;
  }
}

// Mirrors inbound.js's getProactivityCfg. Kept as a separate copy for now
// rather than a shared import so the two call sites (chat vs. meeting) can
// diverge later if live speech turns out to need different tuning e.g.
// meeting ELABORATION may warrant a higher bar than chat ELABORATION.
// Worth revisiting once you have real data from both.
function getProactivityCfg(loadedCfg) {
  const p = loadedCfg?.channels?.webex?.proactivity ?? {};
  return {
    gateThreshold: p.gateThreshold ?? 0.6,
    system1Prob: p.system1Prob ?? 0.05,
    lullWindowMs: p.lullWindowMs ?? 8000,
    lullMaxWaitMs: p.lullMaxWaitMs ?? 30000,
    silenceGapMs: p.silenceGapMs ?? 4 * 60 * 60 * 1000,
    silenceThresholdBonus: p.silenceThresholdBonus ?? 0.15,
    thresholdByType: {
      FACTUAL_CORRECTION: 0.4,
      BLOCKER: 0.45,
      CLARIFICATION: 0.55,
      ELABORATION: 0.75,
      NONE: 1.1,
      ...(p.thresholdByType ?? {}),
    },
    gate: {
      url: p.gate?.url ?? 'https://llm-proxy.dev.outshift.ai/chat/completions',
      model: p.gate?.model ?? 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
      apiKey: process.env.CISCO_LLM_API_KEY ?? '',
    },
  };
}

// segment: { meetingId, personId, text, isFinal, timestamp }
// deps: { cfg, account, log } — same shapes inbound.js already receives
async function ingestTranscript(segment, { cfg, account, log }) {
  if (!segment.isFinal) return;
  const text = String(segment.text ?? '').trim();
  if (!text) return;

  const roomId = resolveRoom(segment.meetingId);
  if (!roomId) {
    log?.warn?.(
      `[webex:meeting] no room bound for meetingId=${segment.meetingId}, dropping segment`
    );
    return;
  }

  const senderName = await resolveSenderName(cfg.token, segment.personId);

  // Meeting and its linked space share one continuity of "conversation" —
  // keyed by roomId, same as chat.
  const lastActivity = getLastSeen(roomId);
  lullRecord(roomId);
  ctxRecord(roomId, { text, senderName });
  prefs.recordHumanMessage(roomId);

  if (!tryAccept(roomId, segment.personId)) {
    log?.info?.(`[webex:meeting:debounce] suppressed burst from ${senderName} in ${roomId}`);
    return;
  }

  const loadedCfg = pluginRuntime?.config?.current?.() ?? {};
  const proactivity = getProactivityCfg(loadedCfg);

  const recentMessages = getRecentMessages(roomId);
  const result = await scoreMessage(
    { text, senderName, chatType: 'group', recentMessages },
    proactivity.gate
  );

  const typeThreshold =
    proactivity.thresholdByType[result.type] ?? proactivity.gateThreshold;

  const silentForMs = lastActivity > 0 ? Date.now() - lastActivity : 0;
  const silenceBonus =
    lastActivity > 0 && silentForMs > proactivity.silenceGapMs
      ? proactivity.silenceThresholdBonus
      : 0;

  const effectiveThreshold = Math.max(
    0.1,
    prefs.getEffectiveThreshold(roomId, typeThreshold, segment.personId) - silenceBonus
  );

  const passesThreshold = result.score >= effectiveThreshold;
  const system1Override = !passesThreshold && Math.random() < proactivity.system1Prob;

  log?.info?.(
    `[webex:meeting:gate] meetingId=${segment.meetingId} roomId=${roomId} type=${result.type} ` +
      `score=${result.score.toFixed(2)} threshold=${effectiveThreshold.toFixed(2)} ` +
      `accepted=${passesThreshold || system1Override}`
  );

  logDecision({
    roomId,
    senderId: segment.personId,
    type: result.type,
    score: result.score,
    threshold: effectiveThreshold,
    accepted: passesThreshold || system1Override,
    system1Override,
    isMentioned: false,
  });

  if (!passesThreshold && !system1Override) return;

  const ctxPayload = {
    Body: text,
    RawBody: text,
    CommandBody: text,
    From: `webex:${segment.personId}`,
    To: `webex:${roomId}`,
    SessionKey: `agent:main:webex:${roomId}`,
    WebexRoomId: roomId,
    AccountId: account.accountId,
    ChatType: 'group',
    SenderName: senderName,
    SenderId: segment.personId,
    Provider: 'webex',
    Surface: 'webex-meeting',
    MessageSid: `meeting:${segment.meetingId}:${segment.timestamp}`,
    Timestamp: new Date(segment.timestamp ?? Date.now()).toISOString(),
    OriginatingChannel: 'webex',
    OriginatingTo: `webex:${roomId}`,
    IsMentioned: false,
    RoomId: roomId,
    MeetingId: segment.meetingId,
  };

  const dispatch =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    log?.warn?.('[webex:meeting] agent pipeline dispatch unavailable');
    return;
  }

  await dispatch({
    ctx: ctxPayload,
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (out) => {
        const reply = (out?.text ?? '').trim();
        if (!reply) return;

        await waitForLull(roomId, {
          windowMs: proactivity.lullWindowMs,
          maxWaitMs: proactivity.lullMaxWaitMs,
        });

        const sent = await webexFetch(cfg.token, '/messages', {
          method: 'POST',
          body: buildMsgBody(roomId, { text: reply }),
        });

        if (sent?.id) prefs.recordProactiveSend(roomId);
      },
      onError: (err) => {
        log?.error?.(`[webex:meeting] reply dispatch error: ${err?.message ?? err}`);
      },
    },
    replyOptions: {},
  });
}

module.exports = { ingestTranscript, setRuntime };
