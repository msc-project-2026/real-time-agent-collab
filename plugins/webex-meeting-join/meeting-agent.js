// Turns a live meeting transcript into (occasional) proactive Space Chat
// interventions.
//
// For each completed speaker turn (from transcription.js) it:
//   1. records the turn as rolling context,
//   2. skips trivially short turns,
//   3. scores it through the SAME proactivity gate the webex chat plugin uses
//      (../webex/gate.js#scoreMessage — reused, not reimplemented),
//   4. and, when the gate clears the threshold, dispatches the transcript to the
//      main agent pipeline and posts the agent's reply into the Webex space the
//      meeting originated from.
//
// The gate + agent dispatcher are shared services owned by other plugins; this
// module is the only new code and it lives entirely in webex-meeting-join.
'use strict';

const { scoreMessage } = require('../webex/gate');

const RECENT_TURNS_MAX = 12;
const MEETING_SENDER = 'Meeting participant';

// Resolve the shared gate LLM config exactly as plugins/webex/inbound.js does,
// so meeting interventions and chat interventions use the same Haiku gate and
// the same CISCO_LLM_API_KEY. Read from live config so a reload takes effect.
function resolveGateCfg(runtime) {
  const loaded = runtime?.config?.current?.() ?? {};
  const gate = loaded?.channels?.webex?.proactivity?.gate ?? {};
  return {
    url: gate.url ?? 'https://llm-proxy.dev.outshift.ai/chat/completions',
    model: gate.model ?? 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
    apiKey: process.env.CISCO_LLM_API_KEY ?? '',
  };
}

function buildAgentPrompt({ transcript, recentTurns }) {
  const history = recentTurns.length
    ? ['Recent meeting transcript (oldest → newest):', ...recentTurns.map((t) => `  • ${t.text}`), ''].join('\n')
    : '';
  return [
    'You are an AI teammate silently listening to a live Webex meeting for a software engineering team.',
    'You have decided this moment is worth a brief, proactive message in the team\'s Webex space.',
    'Write a short, helpful intervention (1–3 sentences): correct a factual error, unblock someone,',
    'answer an open question, or add a genuinely useful pointer. Be concise and skip pleasantries.',
    'If on reflection there is nothing useful to add, reply with an empty message.',
    '',
    history,
    'Latest thing said in the meeting:',
    `"${transcript}"`,
  ].join('\n');
}

// runtime: OpenClaw plugin runtime (api.runtime) — provides the agent dispatcher
//   and live config. postToSpace(roomId, markdown): posts the reply to Webex.
//   scoreMessageFn is injectable for tests; it defaults to the shared webex gate.
function createMeetingAgent({ runtime, postToSpace, gateThreshold, minTurnWords, log, scoreMessageFn = scoreMessage }) {
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

  async function dispatchIntervention({ roomId, meetingId, transcript, recentTurns }) {
    const dispatch = runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
    if (!dispatch) {
      log?.warn?.('[webex-meeting-join] agent pipeline dispatch unavailable; cannot intervene');
      return;
    }
    const loadedCfg = runtime.config?.current?.() ?? {};
    const prompt = buildAgentPrompt({ transcript, recentTurns });
    const now = new Date().toISOString();

    await dispatch({
      ctx: {
        Body: transcript,
        RawBody: transcript,
        CommandBody: prompt,
        From: `webex-meeting:${meetingId}`,
        To: `webex:${roomId}`,
        // Per-room session so the agent keeps meeting context across turns and
        // stays separate from the room's chat session.
        SessionKey: `agent:meeting:webex:${roomId}`,
        WebexRoomId: roomId,
        ChatType: 'group',
        SenderName: MEETING_SENDER,
        SenderId: `webex-meeting:${meetingId}`,
        Provider: 'webex-meeting',
        Surface: 'webex-meeting',
        MessageSid: `webex-meeting:${meetingId}:${Date.now()}`,
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
  }

  // Called once per EndOfTurn. Records context always; gates + dispatches only
  // substantive turns, and never more than one intervention at a time per room.
  async function handleTurn({ roomId, meetingId, transcript }) {
    if (!roomId || !transcript) return;
    const priorTurns = (recentByRoom.get(roomId) ?? []).slice();
    recordTurn(roomId, transcript);

    if (wordCount(transcript) < minTurnWords) return;      // trivially short turn
    if (inFlightRooms.has(roomId)) return;                  // already composing a reply

    let result;
    try {
      result = await scoreMessageFn(
        { text: transcript, senderName: MEETING_SENDER, chatType: 'group', recentMessages: priorTurns.map((t) => ({ senderName: MEETING_SENDER, text: t.text })) },
        resolveGateCfg(runtime)
      );
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] meeting gate error: ${err?.message ?? err}`);
      return;
    }

    const passed = result.score >= gateThreshold && result.type !== 'NONE';
    log?.info?.(
      `[webex-meeting-join] meeting gate room=${roomId} type=${result.type} score=${result.score.toFixed(2)} threshold=${gateThreshold.toFixed(2)} accepted=${passed}`
    );
    if (!passed) return;

    inFlightRooms.add(roomId);
    try {
      await dispatchIntervention({ roomId, meetingId, transcript, recentTurns: priorTurns });
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
