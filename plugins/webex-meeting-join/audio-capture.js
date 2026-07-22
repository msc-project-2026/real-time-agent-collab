// Runs inside the headless Chromium page (bundled into browser-entry.js by
// esbuild — must be listed in browser-runtime.js#ensureBundle bundledSourcePaths
// so the cache invalidates when it changes).
//
// Phase 2, step 2: extract the meeting's remote audio as raw PCM so Node can
// stream it to Deepgram. The Webex remote audio is a live WebRTC MediaStream
// that only exists in this page, so we tap it here, downsample to the 16 kHz
// mono linear16 that Deepgram Flux expects, and hand base64 frames to Node
// through the `sendPcm` binding. This is capture only — the transcription,
// proactivity gate, and agent reply all live in Node (see transcription.js /
// meeting-agent.js).
'use strict';

// 4096 samples @ 16 kHz ≈ 256 ms per frame → ~4 boundary crossings/sec. Big
// enough to keep CDP-binding overhead low, small enough for responsive
// turn detection.
const FRAME_SIZE = 4096;
// Deepgram Flux native rate; a MediaStreamAudioSourceNode created in a context
// at this rate resamples the (typically 48 kHz) WebRTC audio for us.
const TARGET_SAMPLE_RATE = 16_000;

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

// Base64-encode the little-endian bytes of an Int16Array without blowing the
// call stack (String.fromCharCode.apply on a whole frame can). Int16Array is
// already little-endian on all platforms Chromium runs on.
function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// `sendPcm(base64)` crosses the page→Node boundary. `report(level, message)` is
// the same diagnostic sink browser-entry wires up. Best-effort throughout: a
// capture failure must never disturb the meeting the bot is sitting in.
function createPcmCapture({ stream, sendPcm, report }) {
  let audioContext = null;
  let sourceNode = null;
  let processor = null;
  let stopped = false;

  function log(level, message) {
    try { report?.(level, message); } catch { /* logging must never throw */ }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    try { processor?.disconnect(); } catch { /* already gone */ }
    try { sourceNode?.disconnect(); } catch { /* already gone */ }
    if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
    audioContext = null;
    sourceNode = null;
    processor = null;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    log('warn', 'WebAudio unavailable; cannot capture meeting audio for transcription');
    return { stop };
  }
  const audioTracks = stream.getAudioTracks?.() ?? [];
  if (!audioTracks.length) {
    log('warn', 'remote stream has no audio track to capture for transcription');
    return { stop };
  }

  try {
    audioContext = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
    sourceNode = audioContext.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated in favour of AudioWorklet, but the
    // worklet path needs a separately-loaded module URL which is awkward inside
    // this bundled, server-less page. In a controlled headless context the
    // ScriptProcessor is reliable and simplest. 1 input/1 output channel.
    processor = audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);
    processor.onaudioprocess = (event) => {
      if (stopped) return;
      const channelData = event.inputBuffer.getChannelData(0);
      const base64 = int16ToBase64(floatTo16BitPCM(channelData));
      try {
        sendPcm(base64);
      } catch (err) {
        log('warn', `failed to forward audio frame: ${err?.message ?? err}`);
      }
    };
    sourceNode.connect(processor);
    // A ScriptProcessorNode only fires onaudioprocess while connected to a
    // destination (same headless pull requirement the level meter has). Its
    // output buffer is left untouched, so it emits silence.
    processor.connect(audioContext.destination);
    audioContext.resume?.().catch(() => {});

    audioTracks[0].addEventListener?.('ended', () => stop());
    log('info', 'capturing meeting audio for transcription (16kHz linear16)');
  } catch (err) {
    stop();
    log('warn', `failed to start audio capture: ${err?.message ?? err}`);
  }

  return { stop };
}

module.exports = { createPcmCapture };
