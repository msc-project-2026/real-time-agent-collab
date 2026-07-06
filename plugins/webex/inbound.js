// Inbound message filtering, membership checks, and agent pipeline dispatch.
'use strict';

const { webexFetch } = require('./api');
const { getAccessToken } = require('./token');
const { buildMsgBody } = require('./send');
const { scoreMessage } = require('./gate');
const { recordMessage: lullRecord, waitForLull, getLastSeen } = require('./lull');
const { recordMessage: ctxRecord, getRecentMessages } = require('./context');
const { tryAccept } = require('./debounce');
const { logDecision } = require('./audit');
const prefs = require('./prefs');
const { bind: bindMeeting } = require('./roomMap');


let pluginRuntime = null;
function setRuntime(r) {
  pluginRuntime = r;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const base = 300 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * base * 0.5, 5000);
}

async function dispatchWithRetry(dispatch, args, { maxAttempts = 5 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await dispatch(args);
    } catch (err) {
      const isSessionConflict = /session initialization conflicted/i.test(
        err?.message ?? ''
      );
      if (!isSessionConflict || attempt === maxAttempts) throw err;
      await sleep(backoffDelay(attempt));
    }
  }
}

function isDmAllowed(cfg, personId, personEmail) {
  switch (cfg.dmPolicy) {
    case 'allow':
      return true;
    case 'deny':
      return false;
    case 'allowlisted': {
      const list = cfg.allowFrom ?? [];
      return list.includes(personId) || list.includes(personEmail);
    }
    default:
      return false;
  }
}

function getProactivityCfg(loadedCfg) {
  const p = loadedCfg?.channels?.webex?.proactivity ?? {};
  return {
    gateThreshold: p.gateThreshold ?? 0.6,
    system1Prob: p.system1Prob ?? 0.05,
    lullWindowMs: p.lullWindowMs ?? 8000,
    lullMaxWaitMs: p.lullMaxWaitMs ?? 30000,
    // Long-silence re-activation: lower effective threshold after a quiet gap.
    silenceGapMs: p.silenceGapMs ?? 4 * 60 * 60 * 1000,      // 4 hours default
    silenceThresholdBonus: p.silenceThresholdBonus ?? 0.15,    // subtract from threshold
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

// ── /collab command handler ────────────────────────────────────────────────────

async function handleCommand(text, { roomId, personId, token, proactivity, log }) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.toLowerCase().startsWith('/collab')) return false;

  const parts = trimmed.slice(7).trim().split(/\s+/);
  const sub = (parts[0] ?? '').toLowerCase();

  let reply;

  if (sub === 'me') {
    // Per-user commands
    const meSub = (parts[1] ?? '').toLowerCase();

    if (meSub === 'quiet') {
      prefs.setUserOverride(personId, 0.9);
      reply = '🔇 Personal proactivity set to quiet. I\'ll only respond to you when directly mentioned.';
    } else if (meSub === 'active') {
      prefs.setUserOverride(personId, 0.3);
      reply = '🔊 Personal proactivity set to active for your messages.';
    } else if (meSub === 'threshold') {
      const val = parseFloat(parts[2]);
      if (isNaN(val) || val < 0 || val > 1) {
        reply = '⚠️ Usage: `/collab me threshold <0.0–1.0>`';
      } else {
        prefs.setUserOverride(personId, val);
        reply = `✅ Your personal proactivity threshold set to ${val.toFixed(2)}.`;
      }
    } else if (meSub === 'reset') {
      prefs.clearUserOverride(personId);
      reply = '↩️ Your personal proactivity threshold reset to room default.';
    } else {
      reply = [
        '**Personal /collab me commands:**',
        '• `/collab me quiet` — only respond to you when mentioned',
        '• `/collab me active` — engage more freely with your messages',
        '• `/collab me threshold <0.0–1.0>` — set your personal threshold',
        '• `/collab me reset` — restore room default for your messages',
      ].join('\n');
    }
  } else if (sub === 'quiet') {
    prefs.setOverride(roomId, 0.9);
    reply = '🔇 Proactivity set to quiet for this space (threshold 0.9).';
  } else if (sub === 'active') {
    prefs.setOverride(roomId, 0.3);
    reply = '🔊 Proactivity set to active for this space (threshold 0.3).';
  } else if (sub === 'threshold') {
    const val = parseFloat(parts[1]);
    if (isNaN(val) || val < 0 || val > 1) {
      reply = '⚠️ Usage: `/collab threshold <0.0–1.0>`. Lower = more proactive, higher = quieter.';
    } else {
      prefs.setOverride(roomId, val);
      reply = `✅ Proactivity threshold set to ${val.toFixed(2)} for this space.`;
    }
  } else if (sub === 'reset') {
    prefs.clearOverride(roomId);
    reply = '↩️ Proactivity threshold reset to config default for this space.';
  } else if (sub === 'bind-meeting') {
    const meetingId = parts[1];
    if (!meetingId) {
      reply = '⚠️ Usage: `/collab bind-meeting <meetingId>` — run this in the space you want replies posted to.';
    } else {
      bindMeeting(meetingId, roomId);
      reply = `🔗 Bound meeting \`${meetingId}\` to this space. Live reactions will post here.`;
    }
  } else if (sub === 'status') {
    const { effective, source, ratioStr } = prefs.getStatus(
      roomId,
      proactivity.gateThreshold,
      personId
    );
    reply = [
      '📊 **Proactivity status:**',
      `• Effective threshold: **${effective.toFixed(2)}** (${source})`,
      `• Engagement: ${ratioStr}`,
    ].join('\n');
  } else {
    reply = [
      '**Available /collab commands:**',
      '• `/collab quiet` — raise threshold to 0.9 (mostly silent)',
      '• `/collab active` — lower threshold to 0.3 (more proactive)',
      '• `/collab threshold <0.0–1.0>` — set a specific room threshold',
      '• `/collab reset` — restore config default for this space',
      '• `/collab bind-meeting <meetingId>` — link a live meeting to this space',
      '• `/collab status` — show current threshold and engagement stats',
      '• `/collab me quiet/active/threshold/reset` — personal preferences',
    ].join('\n');
  }

  log?.info?.(`[webex:cmd] roomId=${roomId} personId=${personId} sub=${sub}`);

  await webexFetch(token, '/messages', {
    method: 'POST',
    body: buildMsgBody(roomId, { text: reply }),
  });

  return true;
}

// ── Main inbound handler ───────────────────────────────────────────────────────

async function handleInbound(payload, { botId, cfg, account, log }) {
  if (payload.resource !== 'messages' || payload.event !== 'created') return;

  if (payload.data?.personId === botId) return;

  if (payload.data?.roomType === 'direct') {
    if (!isDmAllowed(cfg, payload.data.personId, payload.data.personEmail))
      return;
  }

  const msg = await webexFetch(
    getAccessToken() ?? cfg.token,
    `/messages/${payload.data.id}`
  );

  let membership;
  try {
    membership = await webexFetch(
      cfg.token,
      `/memberships?roomId=${msg.roomId}&personId=${botId}`
    );
  } catch {
    return;
  }
  if (!membership?.items?.length) return;

  const roomId = msg.roomId;
  const senderName = msg.personEmail ?? msg.personId;
  const personId = msg.personId;

  // Capture lastSeen BEFORE recording so we can detect how long the room was silent.
  const lastActivity = getLastSeen(roomId);

  // Record arrival for lull, context, and engagement — always, even if debounced.
  lullRecord(roomId);
  ctxRecord(roomId, { text: msg.text, senderName });
  prefs.recordHumanMessage(roomId);

  const isMentioned =
    Array.isArray(msg.mentionedPeople) && msg.mentionedPeople.includes(botId);

  const loadedCfg = pluginRuntime.config?.current?.() ?? {};
  const proactivity = getProactivityCfg(loadedCfg);

  // ── /collab commands ─────────────────────────────────────────────────────────
  const wasCommand = await handleCommand(msg.text, {
    roomId,
    personId,
    token: cfg.token,
    proactivity,
    log,
  }).catch((err) => {
    log?.error?.(`[webex:cmd] error: ${err?.message ?? err}`);
    return false;
  });
  if (wasCommand) return;

  // ── Debounce ─────────────────────────────────────────────────────────────────
  // Skip gate + dispatch for rapid-fire messages from the same sender.
  // Direct mentions always bypass debounce.
  if (!isMentioned && !tryAccept(roomId, personId)) {
    log?.info?.(`[webex:debounce] suppressed burst from ${senderName} in ${roomId}`);
    return;
  }

  // ── Stage 1: Gate ─────────────────────────────────────────────────────────
  let gateScore = 1.0;
  let interventionType = 'CLARIFICATION';
  let effectiveThreshold = 0;

  if (!isMentioned) {
    const recentMessages = getRecentMessages(roomId);
    const result = await scoreMessage(
      {
        text: msg.text ?? '',
        senderName,
        chatType: msg.roomType === 'direct' ? 'direct' : 'group',
        recentMessages,
      },
      proactivity.gate
    );
    gateScore = result.score;
    interventionType = result.type;

    // Per-type base threshold → apply per-room/per-user override on top
    const typeThreshold =
      proactivity.thresholdByType[interventionType] ?? proactivity.gateThreshold;

    // Long-silence re-activation: subtract bonus if the room has been quiet for a while.
    const silentForMs = lastActivity > 0 ? Date.now() - lastActivity : 0;
    const silenceBonus =
      lastActivity > 0 && silentForMs > proactivity.silenceGapMs
        ? proactivity.silenceThresholdBonus
        : 0;

    effectiveThreshold = Math.max(
      0.1,
      prefs.getEffectiveThreshold(roomId, typeThreshold, personId) - silenceBonus
    );

    const passesThreshold = gateScore >= effectiveThreshold;
    const system1Override = !passesThreshold && Math.random() < proactivity.system1Prob;

    log?.info?.(
      `[webex:gate] roomId=${roomId} type=${interventionType} score=${gateScore.toFixed(2)} ` +
        `typeThreshold=${typeThreshold.toFixed(2)} effectiveThreshold=${effectiveThreshold.toFixed(2)} ` +
        `silenceBonus=${silenceBonus.toFixed(2)} accepted=${passesThreshold || system1Override}`
    );

    // Write audit entry (fire-and-forget — never block message handling)
    logDecision({
      roomId,
      senderId: personId,
      type: interventionType,
      score: gateScore,
      threshold: effectiveThreshold,
      accepted: passesThreshold || system1Override,
      system1Override,
      isMentioned: false,
    });

    if (!passesThreshold && !system1Override) return;
  } else {
    // Mentioned — log to audit but always accepted
    logDecision({
      roomId,
      senderId: personId,
      type: 'MENTION',
      score: 1.0,
      threshold: 0,
      accepted: true,
      isMentioned: true,
    });
  }

  // ── Stage 2: Main agent dispatch ──────────────────────────────────────────
  const ctxPayload = {
    Body: msg.text ?? '',
    RawBody: msg.text ?? '',
    CommandBody: msg.text ?? '',
    From: `webex:${personId}`,
    To: `webex:${roomId}`,
    SessionKey: `agent:main:webex:${roomId}`,
    WebexRoomId: roomId,
    AccountId: account.accountId,
    ChatType: msg.roomType === 'direct' ? 'direct' : 'group',
    SenderName: senderName,
    SenderId: personId,
    Provider: 'webex',
    Surface: 'webex',
    MessageSid: msg.id,
    Timestamp: msg.created,
    OriginatingChannel: 'webex',
    OriginatingTo: `webex:${roomId}`,
    MessageThreadId: msg.parentId,
    IsMentioned: isMentioned,
    RoomId: roomId,
  };

  const dispatch =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    log?.warn?.(`[webex:${account.accountId}] agent pipeline dispatch unavailable`);
    return;
  }

  const capturedIsMentioned = isMentioned;

  await dispatchWithRetry(dispatch, {
    ctx: ctxPayload,
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (out) => {
        log?.info?.(`[webex:${account.accountId}] raw out.text: ${JSON.stringify(out?.text)}`);
        const reply = (out?.text ?? '').trim();
        if (!reply) return;

        // ── Stage 3: Lull wait ────────────────────────────────────────────────
        if (!capturedIsMentioned) {
          await waitForLull(roomId, {
            windowMs: proactivity.lullWindowMs,
            maxWaitMs: proactivity.lullMaxWaitMs,
          });
        }

        const sent = await webexFetch(cfg.token, '/messages', {
          method: 'POST',
          body: buildMsgBody(roomId, { text: reply }, msg.parentId),
        });

        if (sent?.id && !capturedIsMentioned) {
          prefs.recordProactiveSend(roomId);
        }
      },
      onError: (err) => {
        log?.error?.(
          `[webex:${account.accountId}] reply dispatch error: ${err?.message ?? err}`
        );
      },
    },
    replyOptions: {},
  });
}

module.exports = { handleInbound, isDmAllowed, setRuntime };