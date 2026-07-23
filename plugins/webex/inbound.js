// Inbound message filtering, membership checks, and agent pipeline dispatch.
'use strict';

const { webexFetch } = require('./api');
const { getAccessToken } = require('./token');
const { buildMsgBody } = require('./send');
const { isDirectAddress, mentionsName, getAddressNames } = require('./address');
const { scoreMessage } = require('./gate');
const { recordMessage: lullRecord, waitForLull, getLastSeen } = require('./lull');
const { recordMessage: ctxRecord, getRecentMessages } = require('./context');
const { tryAccept } = require('./debounce');
const { logDecision } = require('./audit');
const prefs = require('./prefs');
const { dispatchWithRetry } = require('../../lib/dispatch-retry.js');
const { buildWelcomeCard, buildPresetCard } = require('./card');
const { enqueueSessionDispatch } = require('./session-dispatch');
const { isMeetingControlCommand } = require('./meeting-command');

const { buildRoutingInstruction } = require('./prompts/routing');

let pluginRuntime = null;
function setRuntime(r) {
  pluginRuntime = r;
}

// Webex sometimes re-delivers the same webhook event several times in quick
// succession. Deduplicate by message ID to prevent session initialization
// conflicts and duplicate agent responses.
const recentlyProcessed = new Set();
function isDuplicate(messageId) {
  if (recentlyProcessed.has(messageId)) return true;
  recentlyProcessed.add(messageId);
  setTimeout(() => recentlyProcessed.delete(messageId), 30_000);
  return false;
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
    directAddressNames: Array.isArray(p.directAddressNames) ? p.directAddressNames : [],
    gateThreshold: p.gateThreshold ?? 0.6,
    system1Prob: p.system1Prob ?? 0.05,
    lullWindowMs: p.lullWindowMs ?? 8000,
    lullMaxWaitMs: p.lullMaxWaitMs ?? 30000,
    // Long-silence re-activation: lower effective threshold after a quiet gap.
    silenceGapMs: p.silenceGapMs ?? 4 * 60 * 60 * 1000,      // 4 hours default
    silenceThresholdBonus: p.silenceThresholdBonus ?? 0.15,    // subtract from threshold
    thresholdByType: {
      ADDRESSED: 0.35,
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

async function handleInbound(payload, { botId, botName, cfg, account, log }) {
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

  if (isDuplicate(msg.id)) {
    log?.info?.(`[webex:dedup] skipping duplicate delivery of ${msg.id}`);
    return;
  }

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

  const agentText = msg.text ?? '';

  // Capture lastSeen BEFORE recording so we can detect how long the room was silent.
  const lastActivity = getLastSeen(roomId);

  // Record arrival for lull, context, and engagement — always, even if debounced.
  lullRecord(roomId);
  ctxRecord(roomId, { text: agentText, senderName });
  prefs.recordHumanMessage(roomId);

  const loadedCfg = pluginRuntime.config?.current?.() ?? {};
  const proactivity = getProactivityCfg(loadedCfg);
  const isMentioned =
    Array.isArray(msg.mentionedPeople) && msg.mentionedPeople.includes(botId);
  const isDirectlyAddressed =
    isMentioned ||
    isDirectAddress(agentText, {
      aliases: proactivity.directAddressNames,
      botName,
    });
  // Loose signal: an assistant name appears somewhere in the message. Not a
  // guaranteed reply — the gate decides whether it was talking TO the bot.
  const botNamed =
    isDirectlyAddressed ||
    mentionsName(agentText, {
      aliases: proactivity.directAddressNames,
      botName,
    });

  // Meeting controls are handled by the dedicated meeting-join plugin. Do
  // not send them through the LLM, which has neither the browser SDK session
  // nor the meeting state and otherwise produces a misleading chat reply.
  if (isDirectlyAddressed && isMeetingControlCommand(agentText, botName)) {
    log?.info?.(`[webex:meeting-command] delegated control command in roomId=${roomId}`);
    return;
  }

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
  // Never debounce a message that names the bot — it may be an address.
  if (!botNamed && !tryAccept(roomId, personId)) {
    log?.info?.(`[webex:debounce] suppressed burst from ${senderName} in ${roomId}`);
    return;
  }

  // ── Stage 1: Gate ─────────────────────────────────────────────────────────
  let gateScore = 1.0;
  let interventionType = 'CLARIFICATION';
  let effectiveThreshold = 0;

  if (!isDirectlyAddressed) {
    const recentMessages = getRecentMessages(roomId);
    const result = await scoreMessage(
      {
        text: agentText,
        senderName,
        chatType: msg.roomType === 'direct' ? 'direct' : 'group',
        recentMessages,
        botNamed,
        addressNames: getAddressNames({
          aliases: proactivity.directAddressNames,
          botName,
        }),
      },
      proactivity.gate
    );
    gateScore = result.score;
    interventionType = result.type;

    const typeThreshold =
      proactivity.thresholdByType[interventionType] ?? proactivity.gateThreshold;

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

    logDecision({
      roomId,
      senderId: personId,
      type: interventionType,
      score: gateScore,
      threshold: effectiveThreshold,
      accepted: passesThreshold || system1Override,
      system1Override,
      isMentioned: false,
      isDirectAddressed: false,
    });

    if (!passesThreshold && !system1Override) return;
  } else {
    logDecision({
      roomId,
      senderId: personId,
      type: isMentioned ? 'MENTION' : 'DIRECT_ADDRESS',
      score: 1.0,
      threshold: 0,
      accepted: true,
      isMentioned,
      isDirectAddressed: true,
    });
  }

  // ── Stage 2: Main agent dispatch ──────────────────────────────────────────
  // Gate-confirmed ADDRESSED messages behave like direct addresses downstream:
  // route as append_and_process, reply promptly instead of waiting for a lull,
  // and don't count as proactive sends.
  const treatAsDirect = isDirectlyAddressed || interventionType === 'ADDRESSED';

  const contextHeader = {
    spaceId: roomId,
    messageId: msg.id,
    senderId: personId,
    senderName,
    createdAt: msg.created,
    roomType: msg.roomType,
    isMentioned,
    isDirectlyAddressed: treatAsDirect,
  };

  const routingInstruction = buildRoutingInstruction();

  const ctxPayload = {
    Body: agentText,
    RawBody: agentText,
    CommandBody: [
      routingInstruction,
      '',
      'Webex message context:',
      '```json',
      JSON.stringify(contextHeader, null, 2),
      '```',
      '',
      'Inbound message:',
      agentText,
    ].join('\n'),
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
    IsDirectlyAddressed: treatAsDirect,
    RoomId: roomId,
  };

  const dispatch =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    log?.warn?.(`[webex:${account.accountId}] agent pipeline dispatch unavailable`);
    return;
  }

  const capturedIsDirectlyAddressed = treatAsDirect;

  const dispatchArgs = {
    ctx: ctxPayload,
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (out) => {
        log?.info?.(`[webex:${account.accountId}] raw out.text: ${JSON.stringify(out?.text)}`);
        const reply = (out?.text ?? '').trim();
        if (!reply) return;

        // The LLM prepends its routing decision JSON to the actual response in a
        // single delivery. Strip that prefix so only the human-readable reply reaches Webex.
        if (reply.startsWith('{')) {
          try {
            let depth = 0, end = -1;
            for (let i = 0; i < reply.length; i++) {
              if (reply[i] === '{') depth++;
              else if (reply[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
            }
            if (end > 0) {
              const parsed = JSON.parse(reply.slice(0, end));
              if (parsed && typeof parsed.route === 'string') {
                reply = reply.slice(end).trim();
                log?.info?.(`[webex:${account.accountId}] stripped routing prefix (route=${parsed.route})`);
                if (!reply) return;
              }
            }
          } catch {
            // Not routing JSON — fall through and send as-is
          }
        }

        // ── Stage 3: Lull wait ────────────────────────────────────────────────
        if (!capturedIsDirectlyAddressed) {
          await waitForLull(roomId, {
            windowMs: proactivity.lullWindowMs,
            maxWaitMs: proactivity.lullMaxWaitMs,
          });
        }

        const sent = await webexFetch(cfg.token, '/messages', {
          method: 'POST',
          body: buildMsgBody(roomId, { markdown: reply }, msg.parentId),
        });

        if (sent?.id && !capturedIsDirectlyAddressed) {
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
