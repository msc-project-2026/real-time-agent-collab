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
// How often to sample WebRTC inbound-rtp stats. This is the speech-independent
// proof that audio packets are actually arriving (the RMS meter only sees
// decoded level, which is legitimately 0 in a silent room).
const STATS_INTERVAL_MS = 5_000;

// `report(level, message)` crosses the page→Node boundary (browser-entry wires
// it to the binding browser-runtime exposes). Everything here is best-effort:
// a listening add-on must never destabilise the join it rides on, so no path
// in this module is allowed to throw into its caller.
// `getInboundAudioStats` (optional) is an async function returning
// `{ packetsReceived, bytesReceived, audioLevel }` for the received audio, or
// null when unavailable. It's how we prove RTP is flowing regardless of whether
// anyone is speaking; the RMS meter alone can't tell a quiet room from a dead
// stream.
function createAudioMonitor({ meetingId, report, getInboundAudioStats = null }) {
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
  let lastStatsAt = 0;
  let lastPacketsReceived = null;
  let statsInFlight = false;
  // 'unknown' → 'flowing' → 'stalled'; drives one-shot confirmation and a stall
  // warning rather than a log line every interval.
  let rtpState = 'unknown';

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

  // Speech-independent liveness: compare packetsReceived across polls. Async and
  // self-throttled; never awaited inside tick() so the level meter stays crisp.
  function checkRtpFlow(now) {
    if (!getInboundAudioStats || statsInFlight || now - lastStatsAt < STATS_INTERVAL_MS) return;
    statsInFlight = true;
    lastStatsAt = now;
    Promise.resolve()
      .then(() => getInboundAudioStats())
      .then((stats) => {
        if (!stats || typeof stats.packetsReceived !== 'number') return;
        const previous = lastPacketsReceived;
        const delta = previous == null ? stats.packetsReceived : stats.packetsReceived - previous;
        lastPacketsReceived = stats.packetsReceived;
        const levelText = typeof stats.audioLevel === 'number' ? `, audioLevel=${stats.audioLevel.toFixed(4)}` : '';
        if (delta > 0) {
          if (rtpState !== 'flowing') {
            log('info', `receiving audio RTP from Webex — packets flowing (+${delta}${levelText}, bytes=${stats.bytesReceived ?? '?'})`);
            rtpState = 'flowing';
          }
        } else if (previous != null && rtpState === 'flowing') {
          log('warn', `audio RTP stalled — no new packets in ~${Math.round(STATS_INTERVAL_MS / 1000)}s (packetsReceived=${stats.packetsReceived})`);
          rtpState = 'stalled';
        }
      })
      .catch(() => { /* diagnostics only; never disturb the meeting */ })
      .finally(() => { statsInFlight = false; });
  }

  function tick() {
    if (!analyser || !audioContext) return;
    checkRtpFlow(Date.now());
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
    lastStatsAt = 0;
    lastPacketsReceived = null;
    rtpState = 'unknown';

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
