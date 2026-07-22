// Runs inside the headless Chromium page (bundled into browser-entry.js by
// esbuild — see browser-runtime.js#ensureBundle, which must list this file in
// bundledSourcePaths so the cache invalidates when it changes).
//
// Phase 2, step 1: prove we can actually *hear* a joined meeting. Given a
// remote-audio MediaStream from the Webex SDK, it measures the audio level and
// logs when speech-level sound is (in)audible. It deliberately does NOT ship
// audio anywhere yet — the attached MediaStream is exactly the object a future
// Deepgram real-time transcription pipeline will consume in place of (or
// alongside) this level meter.
'use strict';

const POLL_INTERVAL_MS = 500;
// ~ -40 dBFS RMS. Room/line noise sits below this; speech sits well above it.
const AUDIBLE_RMS_THRESHOLD = 0.01;
// Sustained quiet before we declare the meeting silent, so natural pauses
// between sentences don't flap the state.
const SILENCE_HOLD_MS = 2000;
// While audio keeps flowing, re-confirm periodically instead of logging every
// tick (or staying silent for a long, genuinely-audible stretch).
const AUDIBLE_HEARTBEAT_MS = 30_000;

// `report(level, message)` crosses the page→Node boundary (browser-entry wires
// it to the binding browser-runtime exposes). Everything here is best-effort:
// a listening add-on must never destabilise the join it rides on, so no path
// in this module is allowed to throw into its caller.
function createAudioMonitor({ meetingId, report }) {
  let audioContext = null;
  let sourceNode = null;
  let analyser = null;
  let sink = null;
  let timer = null;
  let stream = null;
  let audible = false;
  let lastAudibleAt = 0;
  let lastHeartbeatAt = 0;
  let stopped = false;

  function log(level, message) {
    try {
      report(level, `${message} (meeting ${meetingId})`);
    } catch {
      // Logging itself must never break the meter.
    }
  }

  function teardownGraph() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try { sourceNode?.disconnect(); } catch { /* already gone */ }
    try { analyser?.disconnect(); } catch { /* already gone */ }
    try { sink?.disconnect(); } catch { /* already gone */ }
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {});
    }
    audioContext = null;
    sourceNode = null;
    analyser = null;
    sink = null;
  }

  function tick() {
    if (!analyser || !audioContext) return;
    // Autoplay policy can leave the context suspended in headless Chromium;
    // resuming is idempotent and required for samples to flow.
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i += 1) sumSquares += samples[i] * samples[i];
    const rms = Math.sqrt(sumSquares / samples.length);
    const now = Date.now();

    if (rms >= AUDIBLE_RMS_THRESHOLD) {
      lastAudibleAt = now;
      if (!audible) {
        audible = true;
        lastHeartbeatAt = now;
        log('info', `meeting audio is audible (rms=${rms.toFixed(4)})`);
      } else if (now - lastHeartbeatAt >= AUDIBLE_HEARTBEAT_MS) {
        lastHeartbeatAt = now;
        log('info', `still receiving audible audio (rms=${rms.toFixed(4)})`);
      }
    } else if (audible && now - lastAudibleAt >= SILENCE_HOLD_MS) {
      audible = false;
      log('info', 'meeting audio went quiet');
    }
  }

  // Called from the SDK's media:ready handler. May be called again if the media
  // connection renegotiates and produces a fresh stream, so it rebuilds cleanly.
  function attachStream(nextStream) {
    if (stopped || !nextStream || nextStream === stream) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      log('warn', 'WebAudio unavailable; cannot monitor meeting audibility');
      return;
    }

    const audioTracks = nextStream.getAudioTracks?.() ?? [];
    if (!audioTracks.length) {
      log('warn', 'remote media stream carried no audio track');
      return;
    }

    teardownGraph();
    stream = nextStream;
    audible = false;
    lastAudibleAt = 0;
    lastHeartbeatAt = 0;

    // Tear down if the media connection ends (meeting ended, or the SDK swapped
    // in a new stream) so we stop metering a dead track.
    audioTracks[0].addEventListener?.('ended', () => {
      if (stream === nextStream) {
        teardownGraph();
        stream = null;
        audible = false;
      }
    });

    try {
      audioContext = new AudioContextCtor();
      sourceNode = audioContext.createMediaStreamSource(nextStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      sourceNode.connect(analyser);
      // Headless Chromium only pulls audio through the graph once it reaches a
      // destination. Route the analyser through a fully-muted gain node so
      // samples flow for measurement without ever emitting sound.
      sink = audioContext.createGain();
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(audioContext.destination);
      audioContext.resume?.().catch(() => {});
      timer = setInterval(tick, POLL_INTERVAL_MS);
      log('info', 'listening to meeting audio');
    } catch (err) {
      teardownGraph();
      log('warn', `failed to start audio meter: ${err?.message ?? err}`);
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    teardownGraph();
    stream = null;
  }

  return { attachStream, stop };
}

module.exports = { createAudioMonitor };
