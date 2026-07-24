// Turns a live meeting transcript into (occasional) proactive Space Chat
// interventions.
//
// For each completed speaker turn (from transcription.js) it:
//   1. records the turn as rolling context,
//   2. skips trivially short turns,
//   3. scores it through the proactivity gate (./gate.js#scoreMessage — vendored
//      from the retired plugins/webex proactivity pipeline),
//   4. and, when the gate clears the threshold, dispatches the transcript to the
//      main agent pipeline and posts the agent's reply into the Webex space the
//      meeting originated from.
//
// gate.js/address.js are vendored copies (the chat plugin's batch pipeline no
// longer ships them), keeping this plugin fully self-contained.
'use strict';

const { scoreMessage } = require('./gate');
const { mentionsName, getAddressNames } = require('./address');
const { dispatchWithSessionRecovery } = require('../../lib/dispatch-retry.js');

const RECENT_TURNS_MAX = 12;
const MEETING_SENDER = 'Meeting participant';

// Gate LLM config: honours a channels.webex.proactivity.gate config block when
// present (the retired chat pipeline's location), else falls back to defaults +
// CISCO_LLM_API_KEY. Read from live config so a reload takes effect.
function resolveGateCfg(runtime) {
  const loaded = runtime?.config?.current?.() ?? {};
  const gate = loaded?.channels?.webex?.proactivity?.gate ?? {};
  return {
    url: gate.url ?? 'https://llm-proxy.dev.outshift.ai/chat/completions',
    model: gate.model ?? 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
    apiKey: process.env.CISCO_LLM_API_KEY ?? '',
  };
}

// Extra assistant names for direct-address detection; the defaults ("bot",
// "agent", "openclaw", …) come from ./address.js. The bot's Webex display
// name isn't known here, but ASR
// rarely transcribes it verbatim anyway — the spoken defaults are what matter.
function resolveAddressAliases(runtime) {
  const loaded = runtime?.config?.current?.() ?? {};
  const names = loaded?.channels?.webex?.proactivity?.directAddressNames;
  return Array.isArray(names) ? names : [];
}

function buildAgentPrompt({ transcript, recentTurns, addressed }) {
  const history = recentTurns.length
    ? ['Recent meeting transcript (oldest → newest):', ...recentTurns.map((t) => `  • ${t.text}`), ''].join('\n')
    : '';
  const intro = addressed
    ? [
        'You are an AI teammate listening to a live Webex meeting for a software engineering team.',
        'A participant just spoke to you directly by name. Answer them with a short, helpful reply',
        '(1–3 sentences) in the team\'s Webex space. Be concise and skip pleasantries.',
        'The transcript comes from speech recognition, so names and terms may be slightly garbled.',
      ]
    : [
        'You are an AI teammate silently listening to a live Webex meeting for a software engineering team.',
        'You have decided this moment is worth a brief, proactive message in the team\'s Webex space.',
        'Write a short, helpful intervention (1–3 sentences): correct a factual error, unblock someone,',
        'answer an open question, or add a genuinely useful pointer. Be concise and skip pleasantries.',
        'If on reflection there is nothing useful to add, reply with an empty message.',
      ];
  return [
    ...intro,
    '',
    history,
    'Latest thing said in the meeting:',
    `"${transcript}"`,
  ].join('\n');
}

// runtime: OpenClaw plugin runtime (api.runtime) — provides the agent dispatcher
//   and live config. postToSpace(roomId, markdown): posts the reply to Webex.
//   scoreMessageFn is injectable for tests; it defaults to the shared webex gate.
function createMeetingAgent({ runtime, postToSpace, gateThreshold, addressedGateThreshold, minTurnWords, log, scoreMessageFn = scoreMessage }) {
  const addressedThreshold = addressedGateThreshold ?? gateThreshold;
  const recentByRoom = new Map(); // roomId -> [{ text }]
  const inFlightRooms = new Set(); // rooms with a dispatch in progress

  function recordTurn(roomId, text) {
    const turns = recentByRoom.get(roomId) ?? [];
    turns.push({ text });
    if (turns.length > RECENT_TURNS_MAX) turns.shift();
    recentByRoom.set(roomId, turns);
  }

  function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  async function dispatchIntervention({ roomId, meetingId, transcript, recentTurns, addressed }) {
    const dispatch = runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
    if (!dispatch) {
      log?.warn?.('[webex-meeting-join] agent pipeline dispatch unavailable; cannot intervene');
      return;
    }
    const loadedCfg = runtime.config?.current?.() ?? {};
    const prompt = buildAgentPrompt({ transcript, recentTurns, addressed });
    const now = new Date().toISOString();
    const canonicalSessionKey = `agent:meeting:webex:${roomId}`;
    const messageSid = `webex-meeting:${meetingId}:${Date.now()}`;

    // The suffix variant only runs for the recovery fallback in
    // dispatchWithSessionRecovery, when the canonical key's initialization
    // conflict never clears (see lib/dispatch-retry.js).
    const buildDispatchArgs = (sessionKeySuffix) => ({
      ctx: {
        Body: transcript,
        RawBody: transcript,
        CommandBody: prompt,
        From: `webex-meeting:${meetingId}`,
        To: `webex:${roomId}`,
        // Per-room session so the agent keeps meeting context across turns and
        // stays separate from the room's chat session.
        SessionKey: sessionKeySuffix
          ? `${canonicalSessionKey}:${sessionKeySuffix}`
          : canonicalSessionKey,
        WebexRoomId: roomId,
        ChatType: 'group',
        SenderName: MEETING_SENDER,
        SenderId: `webex-meeting:${meetingId}`,
        Provider: 'webex-meeting',
        Surface: 'webex-meeting',
        MessageSid: messageSid,
        Timestamp: now,
        OriginatingChannel: 'webex-meeting',
        OriginatingTo: `webex:${roomId}`,
        IsMentioned: true,
      },
      cfg: loadedCfg,
      dispatcherOptions: {
        deliver: async (out) => {
          const reply = (out?.text ?? out?.markdown ?? '').trim();
          if (!reply) return;
          await postToSpace(roomId, reply);
          log?.info?.(`[webex-meeting-join] posted meeting intervention to room=${roomId}`);
        },
        onError: (err) => {
          log?.error?.(`[webex-meeting-join] meeting agent dispatch error: ${err?.message ?? err}`);
        },
      },
      replyOptions: {},
    });

    await dispatchWithSessionRecovery(dispatch, buildDispatchArgs, {
      onRecovery: (recoverySuffix, err) =>
        log?.warn?.(
          `[webex-meeting-join] meeting session conflict persisted after retries; ` +
            `dispatching once with recovery session key ${recoverySuffix}: ${err?.message ?? err}`
        ),
    });
  }

  // Called once per EndOfTurn. Records context always; gates + dispatches only
  // substantive turns, and never more than one intervention at a time per room.
  async function handleTurn({ roomId, meetingId, transcript }) {
    if (!roomId || !transcript) return;
    const priorTurns = (recentByRoom.get(roomId) ?? []).slice();
    recordTurn(roomId, transcript);

    // A turn that names the assistant is never trivially short — "openclaw,
    // thoughts?" must reach the gate.
    const aliases = resolveAddressAliases(runtime);
    const botNamed = mentionsName(transcript, { aliases });
    if (!botNamed && wordCount(transcript) < minTurnWords) return; // trivially short turn
    if (inFlightRooms.has(roomId)) return;                  // already composing a reply

    let result;
    try {
      result = await scoreMessageFn(
        {
          text: transcript,
          senderName: MEETING_SENDER,
          chatType: 'group',
          recentMessages: priorTurns.map((t) => ({ senderName: MEETING_SENDER, text: t.text })),
          botNamed,
          addressNames: getAddressNames({ aliases }),
        },
        resolveGateCfg(runtime)
      );
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] meeting gate error: ${err?.message ?? err}`);
      return;
    }

    const addressed = result.type === 'ADDRESSED';
    const threshold = addressed ? addressedThreshold : gateThreshold;
    const passed = result.score >= threshold && result.type !== 'NONE';
    log?.info?.(
      `[webex-meeting-join] meeting gate room=${roomId} type=${result.type} score=${result.score.toFixed(2)} threshold=${threshold.toFixed(2)} botNamed=${botNamed} accepted=${passed}`
    );
    if (!passed) return;

    inFlightRooms.add(roomId);
    try {
      await dispatchIntervention({ roomId, meetingId, transcript, recentTurns: priorTurns, addressed });
    } catch (err) {
      log?.error?.(`[webex-meeting-join] meeting intervention failed for room=${roomId}: ${err?.message ?? err}`);
    } finally {
      inFlightRooms.delete(roomId);
    }
  }

  // Drop rolling context when a meeting ends so a later meeting in the same room
  // starts clean.
  function clearRoom(roomId) {
    recentByRoom.delete(roomId);
    inFlightRooms.delete(roomId);
  }

  return { handleTurn, clearRoom };
}

module.exports = { createMeetingAgent, buildAgentPrompt, resolveGateCfg };
