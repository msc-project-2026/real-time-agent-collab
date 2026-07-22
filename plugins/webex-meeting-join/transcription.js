// Node-side Deepgram Flux (turn-based streaming ASR) session manager.
//
// One Deepgram WebSocket connection per joined meeting. The browser streams
// 16 kHz linear16 PCM to Node (see audio-capture.js → the __openclawMeetingAudioPcm
// binding in browser-runtime.js); this module feeds that PCM to Deepgram and,
// on each completed speaker turn (EndOfTurn), emits the transcript to `onTurn`.
// The gate + agent-reply decision lives in meeting-agent.js — this module is
// only the ASR transport.
'use strict';

// Bound the pre-open PCM buffer so a socket that never opens can't grow memory
// without limit. ~200 frames of 256 ms ≈ 50 s of audio, then oldest frames drop.
const MAX_PENDING_FRAMES = 200;

// Lazily construct a real Deepgram client. Kept behind a factory so tests inject
// a fake and the (heavy) SDK is only required when transcription is enabled.
// baseUrl is optional — the SDK defaults to https://api.deepgram.com.
function defaultDeepgramFactory(apiKey, baseUrl) {
  const { DeepgramClient } = require('@deepgram/sdk');
  return new DeepgramClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

function createTranscriptionManager({
  apiKey,
  baseUrl,
  model,
  sampleRate,
  eotThreshold,
  eotTimeoutMs,
  log,
  onTurn,
  deepgramFactory = defaultDeepgramFactory,
}) {
  const sessions = new Map(); // sdkMeetingId -> session
  let deepgram = null;

  function client() {
    if (!deepgram) deepgram = deepgramFactory(apiKey, baseUrl);
    return deepgram;
  }

  // Registers the session record synchronously (so PCM arriving during the async
  // connection handshake is buffered, not dropped) then opens the socket.
  // Idempotent per meeting.
  function startSession({ sdkMeetingId, roomId, meetingId }) {
    if (!sdkMeetingId || sessions.has(sdkMeetingId)) return;
    const session = {
      sdkMeetingId,
      roomId,
      meetingId,
      socket: null,
      open: false,
      closing: false,
      pending: [],
    };
    sessions.set(sdkMeetingId, session);
    log?.info?.(`[webex-meeting-join] starting transcription for meeting=${meetingId} room=${roomId}`);

    openSocket(session).catch((err) => {
      log?.error?.(`[webex-meeting-join] transcription connect failed for meeting=${meetingId}: ${err?.message ?? err}`);
      sessions.delete(sdkMeetingId);
    });
  }

  async function openSocket(session) {
    const socket = await client().listen.v2.createConnection({
      model,
      eot_threshold: eotThreshold,
      eot_timeout_ms: eotTimeoutMs,
      encoding: 'linear16',
      sample_rate: sampleRate,
    });

    socket.on('message', (data) => handleMessage(session, data));
    socket.on('error', (err) => {
      log?.warn?.(`[webex-meeting-join] Deepgram error (meeting=${session.meetingId}): ${err?.message ?? err}`);
    });
    socket.on('close', () => {
      session.open = false;
      if (!session.closing) {
        log?.info?.(`[webex-meeting-join] Deepgram connection closed for meeting=${session.meetingId}`);
      }
    });
    socket.on('open', () => {
      session.open = true;
      // Flush anything captured during the handshake, oldest first.
      const backlog = session.pending;
      session.pending = [];
      for (const frame of backlog) trySend(session, frame);
      log?.info?.(`[webex-meeting-join] Deepgram connection open for meeting=${session.meetingId}`);
    });

    // A page teardown may have ended the session while we were connecting.
    if (session.closing) {
      try { socket.close(); } catch { /* ignore */ }
      return;
    }
    session.socket = socket;
    socket.connect();
  }

  function handleMessage(session, data) {
    // Flux turn lifecycle: StartOfTurn / EagerEndOfTurn / TurnResumed / EndOfTurn.
    // We act only on EndOfTurn — the final transcript for a completed turn.
    if (!data || data.event !== 'EndOfTurn') return;
    const transcript = String(data.transcript ?? '').trim();
    if (!transcript) return;
    try {
      onTurn?.({
        sdkMeetingId: session.sdkMeetingId,
        roomId: session.roomId,
        meetingId: session.meetingId,
        transcript,
        turnIndex: data.turn_index,
        confidence: data.end_of_turn_confidence,
      });
    } catch (err) {
      log?.error?.(`[webex-meeting-join] turn handler error (meeting=${session.meetingId}): ${err?.message ?? err}`);
    }
  }

  function trySend(session, frame) {
    try {
      session.socket.sendMedia(frame);
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] failed to send audio to Deepgram (meeting=${session.meetingId}): ${err?.message ?? err}`);
    }
  }

  // base64 linear16 PCM from the browser capture. Buffered until the socket is
  // open; dropped (with the session unknown) if transcription wasn't started for
  // this meeting — losing a few ms of leading audio is harmless.
  function pushPcm(sdkMeetingId, base64) {
    const session = sessions.get(sdkMeetingId);
    if (!session || session.closing) return;
    let frame;
    try {
      frame = Buffer.from(base64, 'base64');
    } catch {
      return;
    }
    if (!frame.length) return;
    if (session.open && session.socket) {
      trySend(session, frame);
      return;
    }
    session.pending.push(frame);
    if (session.pending.length > MAX_PENDING_FRAMES) session.pending.shift();
  }

  function endSession(sdkMeetingId) {
    const session = sessions.get(sdkMeetingId);
    if (!session) return;
    session.closing = true;
    sessions.delete(sdkMeetingId);
    session.pending = [];
    try {
      // Tell Deepgram no more audio is coming so it flushes, then close.
      session.socket?.sendCloseStream?.({ type: 'CloseStream' });
    } catch { /* best effort */ }
    try {
      session.socket?.close?.();
    } catch { /* best effort */ }
    log?.info?.(`[webex-meeting-join] stopped transcription for meeting=${session.meetingId}`);
  }

  function dispose() {
    for (const sdkMeetingId of Array.from(sessions.keys())) endSession(sdkMeetingId);
  }

  return { startSession, pushPcm, endSession, dispose };
}

module.exports = { createTranscriptionManager };
