// Reads this plugin's own configuration directly from process.env — no
// config/openclaw.json schema wiring, so the plugin ports to another
// OpenClaw instance by copying the folder and setting these env vars.
'use strict';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // fallback reconciliation sweep
const DEFAULT_JOIN_TIMEOUT_MS = 20_000;
const MIN_POLL_INTERVAL_MS = 30_000;

// Deepgram Flux (turn-based streaming ASR) defaults. Flux emits StartOfTurn /
// EagerEndOfTurn / TurnResumed / EndOfTurn; we act on EndOfTurn only.
const DEFAULT_DEEPGRAM_MODEL = 'flux-general-en';
const DEFAULT_EOT_THRESHOLD = 0.7;
const DEFAULT_EOT_TIMEOUT_MS = 5000;
// Deepgram Flux linear16 input; 16 kHz mono is the model's native rate and what
// the in-browser WebAudio capture downsamples to.
const DEEPGRAM_SAMPLE_RATE = 16_000;
// Skip trivially short turns ("yeah", "right", "mm-hmm") before spending a gate
// LLM call — a live meeting produces many of these.
const DEFAULT_MIN_TURN_WORDS = 5;
// Meeting interventions use a single gate threshold (the webex chat plugin has
// per-type thresholds; meeting turns are noisier, so we keep one conservative
// bar). Tunable via env.
const DEFAULT_MEETING_GATE_THRESHOLD = 0.7;
// Lower bar when the gate classifies a turn as ADDRESSED (a participant spoke
// to the assistant by name). Higher than the chat plugin's 0.35 because ASR
// noise makes false name hits more likely in meetings.
const DEFAULT_MEETING_ADDRESSED_THRESHOLD = 0.45;

// Webex transcript processing is asynchronous after a meeting ends. The
// transcript-created webhook is primary; these values govern the bounded
// polling recovery started by meetings/ended when that webhook is missed.
const DEFAULT_TRANSCRIPT_RECOVERY_DELAY_MS = 60_000;
const DEFAULT_TRANSCRIPT_RECOVERY_MAX_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_TRANSCRIPT_RECOVERY_WINDOW_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MINUTES_CHUNK_CHARS = null; // unlimited; chunking is opt-in

function trimmed(v) {
  const s = v == null ? '' : String(v).trim();
  return s || undefined;
}

function enabledByDefault(v) {
  if (v == null) return true;
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());
}

function boundedNumber(value, { min, fallback }) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function optionalPositiveNumber(value) {
  const parsed = Number(value);
  return value != null && String(value).trim() && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : null;
}

// The dedicated human "meeting" account's credentials fall back to the same
// vars the existing webex plugin already uses (WEBEX_ACCESS_TOKEN etc.) since
// the user confirmed those are already populated for that account. Dedicated
// WEBEX_MEETING_* vars let this plugin use a *different* account than the
// primary webex plugin if a deployment ever wants that split.
function getConfig(env = process.env) {
  const botToken = trimmed(env.WEBEX_BOT_TOKEN);
  const meetingAccessToken = trimmed(env.WEBEX_MEETING_ACCESS_TOKEN) ?? trimmed(env.WEBEX_ACCESS_TOKEN);
  const meetingRefreshToken = trimmed(env.WEBEX_MEETING_REFRESH_TOKEN) ?? trimmed(env.WEBEX_REFRESH_TOKEN);
  const meetingClientId = trimmed(env.WEBEX_MEETING_CLIENT_ID) ?? trimmed(env.WEBEX_CLIENT_ID);
  const meetingClientSecret = trimmed(env.WEBEX_MEETING_CLIENT_SECRET) ?? trimmed(env.WEBEX_CLIENT_SECRET);
  const webhookBaseUrl = trimmed(env.WEBEX_MEETING_WEBHOOK_URL);
  const webhookSecret = trimmed(env.WEBEX_WEBHOOK_SECRET);
  const transcriptionProvider = trimmed(env.WEBEX_MEETING_TRANSCRIPTION_PROVIDER)?.toLowerCase() ?? 'webex';

  const missing = [
    !botToken && 'WEBEX_BOT_TOKEN',
    !meetingAccessToken && 'WEBEX_MEETING_ACCESS_TOKEN (or WEBEX_ACCESS_TOKEN)',
    !webhookBaseUrl && 'WEBEX_MEETING_WEBHOOK_URL',
  ].filter(Boolean);
  if (missing.length) throw new Error(`webex-meeting-join: missing ${missing.join(', ')}`);
  if (!['webex', 'deepgram', 'off'].includes(transcriptionProvider)) {
    throw new Error('webex-meeting-join: WEBEX_MEETING_TRANSCRIPTION_PROVIDER must be webex, deepgram, or off');
  }

  const pollIntervalMsRaw = Number(env.WEBEX_MEETING_POLL_INTERVAL_MS);
  const pollIntervalMs = Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw >= MIN_POLL_INTERVAL_MS
    ? pollIntervalMsRaw
    : DEFAULT_POLL_INTERVAL_MS;

  const joinTimeoutMsRaw = Number(env.WEBEX_MEETING_JOIN_TIMEOUT_MS);
  const joinTimeoutMs = Number.isFinite(joinTimeoutMsRaw) && joinTimeoutMsRaw > 0
    ? joinTimeoutMsRaw
    : DEFAULT_JOIN_TIMEOUT_MS;

  // Optional path to the Chromium-based browser binary Playwright should
  // launch. The Webex SDK hard-requires H264 in the SDP it negotiates for
  // addMedia() (even for our audio-only, receive-only connection — the video
  // m-line is always present), and Playwright's stock Chromium ships without
  // proprietary codecs. When unset, browser-runtime auto-detects Brave (which
  // bundles H264) before falling back to Playwright's Chromium.
  const browserExecutablePath = trimmed(env.WEBEX_MEETING_BROWSER_EXECUTABLE);

  const deepgramApiKey = trimmed(env.DEEPGRAM_API_KEY);
  if (transcriptionProvider === 'deepgram' && !deepgramApiKey) {
    throw new Error('webex-meeting-join: DEEPGRAM_API_KEY is required when WEBEX_MEETING_TRANSCRIPTION_PROVIDER=deepgram');
  }
  // Optional: override the Deepgram endpoint (proxy or self-hosted). The SDK
  // already defaults to https://api.deepgram.com, so leaving this unset is the
  // same as pointing it there.
  const deepgramBaseUrl = trimmed(env.DEEPGRAM_BASE_URL);

  const eotThresholdRaw = Number(env.WEBEX_MEETING_EOT_THRESHOLD);
  const eotTimeoutMsRaw = Number(env.WEBEX_MEETING_EOT_TIMEOUT_MS);
  const minTurnWordsRaw = Number(env.WEBEX_MEETING_MIN_TURN_WORDS);
  const gateThresholdRaw = Number(env.WEBEX_MEETING_GATE_THRESHOLD);
  const addressedThresholdRaw = Number(env.WEBEX_MEETING_ADDRESSED_GATE_THRESHOLD);

  const transcription = {
    enabled: transcriptionProvider !== 'off',
    provider: transcriptionProvider,
    apiKey: deepgramApiKey,
    baseUrl: deepgramBaseUrl,
    model: trimmed(env.WEBEX_MEETING_DEEPGRAM_MODEL) ?? DEFAULT_DEEPGRAM_MODEL,
    sampleRate: DEEPGRAM_SAMPLE_RATE,
    eotThreshold: eotThresholdRaw > 0 && eotThresholdRaw <= 1 ? eotThresholdRaw : DEFAULT_EOT_THRESHOLD,
    eotTimeoutMs: Number.isFinite(eotTimeoutMsRaw) && eotTimeoutMsRaw > 0 ? eotTimeoutMsRaw : DEFAULT_EOT_TIMEOUT_MS,
    minTurnWords: Number.isFinite(minTurnWordsRaw) && minTurnWordsRaw >= 0 ? minTurnWordsRaw : DEFAULT_MIN_TURN_WORDS,
    gateThreshold: gateThresholdRaw > 0 && gateThresholdRaw <= 1 ? gateThresholdRaw : DEFAULT_MEETING_GATE_THRESHOLD,
    addressedGateThreshold:
      addressedThresholdRaw > 0 && addressedThresholdRaw <= 1
        ? addressedThresholdRaw
        : DEFAULT_MEETING_ADDRESSED_THRESHOLD,
  };

  const minutes = {
    enabled: enabledByDefault(env.WEBEX_MEETING_MINUTES_ENABLED),
    recoveryDelayMs: boundedNumber(env.WEBEX_MEETING_TRANSCRIPT_RECOVERY_DELAY_MS, {
      min: 5_000,
      fallback: DEFAULT_TRANSCRIPT_RECOVERY_DELAY_MS,
    }),
    recoveryMaxDelayMs: boundedNumber(env.WEBEX_MEETING_TRANSCRIPT_RECOVERY_MAX_DELAY_MS, {
      min: 5_000,
      fallback: DEFAULT_TRANSCRIPT_RECOVERY_MAX_DELAY_MS,
    }),
    recoveryWindowMs: boundedNumber(env.WEBEX_MEETING_TRANSCRIPT_RECOVERY_WINDOW_MS, {
      min: 60_000,
      fallback: DEFAULT_TRANSCRIPT_RECOVERY_WINDOW_MS,
    }),
    chunkChars: optionalPositiveNumber(env.WEBEX_MEETING_MINUTES_CHUNK_CHARS),
  };

  return {
    browserExecutablePath,
    transcription,
    minutes,
    botToken,
    meetingAccessToken,
    meetingRefreshToken,
    meetingClientId,
    meetingClientSecret,
    canRefreshMeetingToken: Boolean(meetingRefreshToken && meetingClientId && meetingClientSecret),
    webhookBaseUrl: webhookBaseUrl.replace(/\/+$/, ''),
    webhookSecret,
    pollIntervalMs,
    joinTimeoutMs,
  };
}

module.exports = {
  getConfig,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_JOIN_TIMEOUT_MS,
  DEFAULT_DEEPGRAM_MODEL,
  DEEPGRAM_SAMPLE_RATE,
  DEFAULT_TRANSCRIPT_RECOVERY_DELAY_MS,
  DEFAULT_TRANSCRIPT_RECOVERY_MAX_DELAY_MS,
  DEFAULT_TRANSCRIPT_RECOVERY_WINDOW_MS,
  DEFAULT_MINUTES_CHUNK_CHARS,
};
