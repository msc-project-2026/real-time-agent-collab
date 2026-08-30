'use strict';

// Converts the Webex SDK's cumulative caption payloads into one final turn per
// caption while attaching the REST meeting/room identity known only to Node.
function createWebexTranscriptionManager({ onTurn, log }) {
  const sessions = new Map();

  function startSession({ sdkMeetingId, roomId, meetingId }) {
    if (sdkMeetingId) sessions.set(sdkMeetingId, { roomId, meetingId, emitted: new Set() });
  }

  function pushCaptions(sdkMeetingId, payload) {
    const session = sessions.get(sdkMeetingId);
    if (!session) return;
    for (const caption of payload?.captions ?? []) {
      const transcript = String(caption?.text ?? '').trim();
      const key = caption?.id ?? `${caption?.timestamp ?? ''}:${caption?.speaker?.speakerId ?? ''}:${transcript}`;
      if (!caption?.isFinal || !transcript || session.emitted.has(key)) continue;
      session.emitted.add(key);
      try {
        onTurn?.({
          sdkMeetingId,
          roomId: session.roomId,
          meetingId: session.meetingId,
          transcript,
          speaker: caption.speaker,
          timestamp: caption.timestamp,
        });
      } catch (err) {
        log?.error?.(`[webex-meeting-join] Webex caption handler error: ${err?.message ?? err}`);
      }
    }
  }

  function endSession(sdkMeetingId) {
    sessions.delete(sdkMeetingId);
  }

  function dispose() {
    sessions.clear();
  }

  return { startSession, pushCaptions, endSession, dispose };
}

module.exports = { createWebexTranscriptionManager };
