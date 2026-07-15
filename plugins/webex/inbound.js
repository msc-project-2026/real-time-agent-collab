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
const { dispatchWithRetry } = require('../../lib/dispatch-retry.js');
const { buildWelcomeCard, buildPresetCard } = require('./card');
const { enqueueSessionDispatch } = require('./session-dispatch');

let pluginRuntime = null;
function setRuntime(r) {
  pluginRuntime = r;
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


function buildHelp() {
  const presetLines = Object.entries(prefs.PRESETS)
    .map(([name, p]) => `• \`/collab ${name}\` — ${p.desc}`)
    .join('\n');
  return [
    '**Set a proactivity mode for this space:**',
    presetLines,
    '',
    '**Other commands:**',
    '• `/collab settings` — open the settings card (easier than typing commands)',
    '• `/collab threshold <0.0–1.0>` — fine-grained control (power users)',
    '• `/collab reset` — restore config default',
    '• `/collab status` — current mode, engagement stats, and file watches',
    '• `/collab watch <pattern>` — notify only for matching files (e.g. `src/**`, `*.py`)',
    '• `/collab unwatch <pattern>` — remove a file watch',
    '• `/collab watches` — list active file watches',
    '• `/collab me <mode>` — personal mode (overrides room setting)',
  ].join('\n');
}

function buildMeHelp() {
  const presetLines = Object.entries(prefs.PRESETS)
    .map(([name, p]) => `• \`/collab me ${name}\` — ${p.desc}`)
    .join('\n');
  return [
    '**Set your personal proactivity mode:**',
    presetLines,
    '',
    '• `/collab me threshold <0.0–1.0>` — fine-grained control',
    '• `/collab me reset` — restore room default',
  ].join('\n');
}

async function handleCommand(text, { roomId, personId, token, proactivity, log }) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.toLowerCase().startsWith('/collab')) return false;

  const parts = trimmed.slice(7).trim().split(/\s+/);
  const sub = (parts[0] ?? '').toLowerCase();

  const PRESET_NAMES = Object.keys(prefs.PRESETS);
  let reply;

  if (sub === 'me') {
    const meSub = (parts[1] ?? '').toLowerCase();

    if (PRESET_NAMES.includes(meSub)) {
      const preset = prefs.PRESETS[meSub];
      prefs.setUserPreset(personId, meSub);
      reply = `${preset.emoji} Your personal mode set to **${preset.label}** — ${preset.desc}.`;
    } else if (meSub === 'threshold') {
      const val = parseFloat(parts[2]);
      if (isNaN(val) || val < 0 || val > 1) {
        reply = '⚠️ Usage: `/collab me threshold <0.0–1.0>`';
      } else {
        prefs.setUserOverride(personId, val);
        reply = `✅ Your personal threshold set to ${val.toFixed(2)}.`;
      }
    } else if (meSub === 'reset') {
      prefs.clearUserOverride(personId);
      reply = '↩️ Your personal mode reset to room default.';
    } else {
      reply = buildMeHelp();
    }

  } else if (PRESET_NAMES.includes(sub)) {
    const preset = prefs.PRESETS[sub];
    prefs.setPreset(roomId, sub);
    reply = `${preset.emoji} Room mode set to **${preset.label}** — ${preset.desc}.`;

  } else if (sub === 'threshold') {
    const val = parseFloat(parts[1]);
    if (isNaN(val) || val < 0 || val > 1) {
      reply = '⚠️ Usage: `/collab threshold <0.0–1.0>`. Lower = more proactive, higher = quieter.';
    } else {
      prefs.setOverride(roomId, val);
      reply = `✅ Room threshold set to ${val.toFixed(2)}.`;
    }

  } else if (sub === 'reset') {
    prefs.clearOverride(roomId);
    reply = '↩️ Room mode reset to config default.';

  } else if (sub === 'watch') {
    const pattern = parts.slice(1).join(' ').trim();
    if (!pattern) {
      reply = '⚠️ Usage: `/collab watch <pattern>` — e.g. `src/**`, `*.py`, `package.json`';
    } else {
      prefs.addWatchPattern(roomId, pattern);
      reply = `👁 Watching \`${pattern}\` — I'll notify this space when matching files change on GitHub.`;
    }

  } else if (sub === 'unwatch') {
    const pattern = parts.slice(1).join(' ').trim();
    if (!pattern) {
      reply = '⚠️ Usage: `/collab unwatch <pattern>`';
    } else {
      const removed = prefs.removeWatchPattern(roomId, pattern);
      reply = removed
        ? `✅ Removed watch pattern \`${pattern}\`.`
        : `⚠️ Pattern \`${pattern}\` wasn't in the watch list.`;
    }

  } else if (sub === 'watches') {
    const patterns = prefs.getWatchPatterns(roomId);
    reply = patterns.length
      ? `👁 **Active file watches:**\n${patterns.map((p) => `• \`${p}\``).join('\n')}`
      : '👁 No file watches set — all significant commits notify this space.';

  } else if (sub === 'settings') {
    // Resend the preset picker card so anyone can change the mode without typing commands.
    const currentPreset =
      prefs.getPresetName(prefs.getOverride(roomId) ?? prefs.getEffectiveThreshold(roomId, proactivity.gateThreshold)) ??
      'balanced';
    log?.info?.(`[webex:cmd] sending settings card roomId=${roomId}`);
    await webexFetch(token, '/messages', {
      method: 'POST',
      body: buildPresetCard(roomId, { currentPreset }),
    });
    return true;

  } else if (sub === 'status') {
    const { effective, source, ratioStr, adjustStr, patterns } = prefs.getStatus(
      roomId,
      proactivity.gateThreshold,
      personId
    );
    const lines = [
      '📊 **Proactivity status:**',
      `• Mode: **${effective.toFixed(2)}** (${source})`,
      `• Engagement: ${ratioStr}`,
    ];
    if (adjustStr) lines.push(`• Auto-adjust: ${adjustStr}`);
    lines.push(
      patterns.length
        ? `• Watching: ${patterns.map((p) => `\`${p}\``).join(', ')}`
        : '• Watching: all significant commits'
    );
    reply = lines.join('\n');

  } else {
    reply = buildHelp();
  }

  log?.info?.(`[webex:cmd] roomId=${roomId} personId=${personId} sub=${sub}`);

  await webexFetch(token, '/messages', {
    method: 'POST',
    body: buildMsgBody(roomId, { markdown: reply }),
  });

  return true;
}

// ── Main inbound handler ───────────────────────────────────────────────────────

// ── Card action handler ───────────────────────────────────────────────────────

async function handleCardAction(payload, { botId, cfg, log }) {
  // Fetch full action (webhook payload doesn't include inputs)
  const action = await webexFetch(cfg.token, `/attachment/actions/${payload.data?.id}`);
  if (!action) return;

  const { personId, roomId, inputs } = action;
  if (!personId || !roomId || personId === botId) return;
  if (inputs?.cardAction !== 'setPreset') return;

  const presetName = inputs.preset;
  const scope = inputs.scope; // 'room' or 'me'
  const preset = prefs.PRESETS[presetName];
  if (!preset) return;

  if (scope === 'me') {
    prefs.setUserPreset(personId, presetName);
    await webexFetch(cfg.token, '/messages', {
      method: 'POST',
      body: { roomId, markdown: `${preset.emoji} Your personal mode set to **${preset.label}** — ${preset.desc}.` },
    });
  } else {
    prefs.setPreset(roomId, presetName);
    await webexFetch(cfg.token, '/messages', {
      method: 'POST',
      body: {
        roomId,
        markdown:
          `${preset.emoji} Room mode set to **${preset.label}** — ${preset.desc}.\n\n` +
          `This applies to both proactive replies and GitHub commit notifications in this space.`,
      },
    });
  }

  log?.info?.(`[webex:card] preset=${presetName} scope=${scope} roomId=${roomId} personId=${personId}`);
}

// ── Main inbound handler ───────────────────────────────────────────────────────

async function handleInbound(payload, { botId, cfg, account, log }) {
  // Bot was added to a new space → send the welcome card.
  if (payload.resource === 'memberships' && payload.event === 'created') {
    if (payload.data?.personId === botId) {
      const roomId = payload.data.roomId;
      log?.info?.(`[webex:welcome] bot joined roomId=${roomId}`);
      await webexFetch(cfg.token, '/messages', {
        method: 'POST',
        body: buildWelcomeCard(roomId),
      }).catch((err) =>
        log?.error?.(`[webex:welcome] could not send welcome card: ${err?.message ?? err}`)
      );
    }
    return;
  }

  // Someone submitted a settings card.
  if (payload.resource === 'attachmentActions' && payload.event === 'created') {
    await handleCardAction(payload, { botId, cfg, log }).catch((err) =>
      log?.error?.(`[webex:card] action handler error: ${err?.message ?? err}`)
    );
    return;
  }

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

  const isMentioned =
    Array.isArray(msg.mentionedPeople) && msg.mentionedPeople.includes(botId);

  // Meeting credentials are intentionally passed to the agent with the request.
  // The agent supplies them directly to the meeting-join tool; invitations are
  // not cached or resolved from room history.
  const agentText = msg.text ?? '';

  // Capture lastSeen BEFORE recording so we can detect how long the room was silent.
  const lastActivity = getLastSeen(roomId);

  // Record arrival for lull, context, and engagement — always, even if debounced.
  lullRecord(roomId);
  ctxRecord(roomId, { text: agentText, senderName });
  prefs.recordHumanMessage(roomId);

  const loadedCfg = pluginRuntime.config?.current?.() ?? {};
  const proactivity = getProactivityCfg(loadedCfg);

  // ── /collab commands ─────────────────────────────────────────────────────────
  const wasCommand = await handleCommand(agentText, {
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
        text: agentText,
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
    Body: agentText,
    RawBody: agentText,
    CommandBody: agentText,
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

  const dispatchArgs = {
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

        // Send as `markdown` so the agent's Markdown reply renders with
        // formatting (bold, lists, code, links) instead of raw asterisks.
        // Webex derives a plain-text fallback for non-rich clients.
        const sent = await webexFetch(cfg.token, '/messages', {
          method: 'POST',
          body: buildMsgBody(roomId, { markdown: reply }, msg.parentId),
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
  };

  await enqueueSessionDispatch(ctxPayload.SessionKey, () =>
    dispatchWithRetry(dispatch, dispatchArgs)
  );
}

module.exports = { handleInbound, isDmAllowed, setRuntime };
