'use strict';

// Per-room and per-user proactivity state.
//
// Copied from the retired plugins/webex proactivity pipeline so this plugin
// stays self-contained. Only shouldNotify() is exercised today; the override
// setters remain for a future command surface (nothing currently writes them,
// so shouldNotify defaults to notifying).
//
// Threshold priority (highest → lowest):
//   1. User override  (/collab me <mode>)    — per-person, overrides everything
//   2. Room override  (/collab <mode>)        — room-wide explicit setting
//   3. Auto-adjusted                          — computed from engagement history
//   4. Config default (gateThreshold)         — openclaw.json baseline

// ── Presets ───────────────────────────────────────────────────────────────────

const PRESETS = {
  silent:   { threshold: 0.95, label: 'Silent',   desc: 'Only respond when directly mentioned', emoji: '🔕' },
  quiet:    { threshold: 0.80, label: 'Quiet',     desc: 'Blockers and corrections only',        emoji: '🔇' },
  balanced: { threshold: 0.60, label: 'Balanced',  desc: 'Default — speak when genuinely useful', emoji: '⚖️' },
  active:   { threshold: 0.35, label: 'Active',    desc: 'Engage more freely with the conversation', emoji: '🔊' },
  max:      { threshold: 0.20, label: 'Max',       desc: 'Respond to most messages',             emoji: '📢' },
};

function getPresetName(threshold) {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (Math.abs(p.threshold - threshold) < 0.01) return name;
  }
  return null;
}

// ── Room-level state ──────────────────────────────────────────────────────────

// Map<roomId, number> — from /collab commands
const explicitOverrides = new Map();

// Map<roomId, number> — computed from engagement, never overwrites explicit
const autoThresholds = new Map();

// Map<roomId, Array<{ sentAt: ms, engaged: bool }>>
const proactiveLogs = new Map();

// Map<roomId, Array<{ ts: ms, direction: 'up'|'down', from: number, to: number }>>
const autoAdjustLog = new Map();

// ── User-level state ──────────────────────────────────────────────────────────

// Map<personId, number> — from /collab me commands
const userOverrides = new Map();

// ── File watch patterns (for source observer notifications) ───────────────────

// Map<roomId, Set<string>> — glob patterns; empty = notify for all
const watchPatterns = new Map();

// ── Constants ─────────────────────────────────────────────────────────────────

const ENGAGE_WINDOW_MS = 2 * 60 * 1000;
const ROLLING_WINDOW = 10;
const ADJUST_STEP = 0.05;
const MIN_THRESHOLD = 0.2;
const MAX_THRESHOLD = 0.95;
const MIN_SAMPLES = 3;

function clamp(v) {
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Number(v)));
}

// ── Room override API ─────────────────────────────────────────────────────────

function setOverride(roomId, threshold) {
  explicitOverrides.set(roomId, clamp(threshold));
}

function clearOverride(roomId) {
  explicitOverrides.delete(roomId);
}

function getOverride(roomId) {
  return explicitOverrides.get(roomId) ?? null;
}

function setPreset(roomId, name) {
  const preset = PRESETS[name];
  if (!preset) return false;
  setOverride(roomId, preset.threshold);
  return true;
}

// ── User override API ─────────────────────────────────────────────────────────

function setUserOverride(personId, threshold) {
  userOverrides.set(personId, clamp(threshold));
}

function clearUserOverride(personId) {
  userOverrides.delete(personId);
}

function getUserOverride(personId) {
  return userOverrides.get(personId) ?? null;
}

function setUserPreset(personId, name) {
  const preset = PRESETS[name];
  if (!preset) return false;
  setUserOverride(personId, preset.threshold);
  return true;
}

// ── Effective threshold ───────────────────────────────────────────────────────

function getEffectiveThreshold(roomId, baseThreshold, personId = null) {
  if (personId && userOverrides.has(personId)) return userOverrides.get(personId);
  if (explicitOverrides.has(roomId)) return explicitOverrides.get(roomId);
  if (autoThresholds.has(roomId)) return autoThresholds.get(roomId);
  return baseThreshold;
}

// ── Engagement tracking ───────────────────────────────────────────────────────

function recordProactiveSend(roomId) {
  const log = proactiveLogs.get(roomId) ?? [];
  log.push({ sentAt: Date.now(), engaged: false });
  if (log.length > ROLLING_WINDOW) log.shift();
  proactiveLogs.set(roomId, log);
}

function recordHumanMessage(roomId) {
  const log = proactiveLogs.get(roomId);
  if (!log?.length) return;

  const now = Date.now();
  let changed = false;
  for (const entry of log) {
    if (!entry.engaged && now - entry.sentAt < ENGAGE_WINDOW_MS) {
      entry.engaged = true;
      changed = true;
    }
  }

  if (changed) runAutoAdjust(roomId);
}

// ── File watch patterns ───────────────────────────────────────────────────────

function matchGlob(pattern, filePath) {
  const re = new RegExp(
    '^' +
    String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials except * and ?
      .replace(/\*\*/g, '\x00')              // placeholder for **
      .replace(/\*/g, '[^/]*')               // * matches within a path segment
      .replace(/\?/g, '[^/]')               // ? matches single char, not /
      .replace(/\x00/g, '.*') +             // ** matches across segments
    '$',
    'i'
  );
  return re.test(filePath);
}

function addWatchPattern(roomId, pattern) {
  const set = watchPatterns.get(roomId) ?? new Set();
  set.add(pattern.trim());
  watchPatterns.set(roomId, set);
}

function removeWatchPattern(roomId, pattern) {
  return watchPatterns.get(roomId)?.delete(pattern.trim()) ?? false;
}

function clearWatchPatterns(roomId) {
  watchPatterns.delete(roomId);
}

function getWatchPatterns(roomId) {
  return [...(watchPatterns.get(roomId) ?? [])];
}

// Returns true if the room should receive a commit notification.
// Two independent filters apply in order:
//   1. Mode filter — silent suppresses all; quiet allows only breaking changes.
//   2. File watch filter — if patterns are set, at least one file must match.
function shouldNotify(roomId, files = [], { isBreaking = false } = {}) {
  const override = explicitOverrides.get(roomId) ?? autoThresholds.get(roomId);
  if (override != null) {
    if (override >= PRESETS.silent.threshold) return false;               // silent → no pings
    if (override >= PRESETS.quiet.threshold && !isBreaking) return false; // quiet → breaking only
  }

  const patterns = watchPatterns.get(roomId);
  if (!patterns || patterns.size === 0) return true;
  return files.some((f) => [...patterns].some((p) => matchGlob(p, f)));
}

// ── Status (for /collab status) ───────────────────────────────────────────────

function getStatus(roomId, baseThreshold, personId = null) {
  const userOverride = personId ? getUserOverride(personId) : null;
  const roomOverride = getOverride(roomId);
  const auto = autoThresholds.get(roomId);
  const effective = getEffectiveThreshold(roomId, baseThreshold, personId);

  const userPresetName = userOverride != null ? getPresetName(userOverride) : null;
  const roomPresetName = roomOverride != null ? getPresetName(roomOverride) : null;

  const source =
    userOverride != null ? `your personal override${userPresetName ? ` (${userPresetName})` : ''}` :
    roomOverride != null ? `room override${roomPresetName ? ` (${roomPresetName})` : ''}` :
    auto != null         ? 'auto-adjusted' :
                           'config default';

  const samples = (proactiveLogs.get(roomId) ?? []).length;
  const ratio = engagementRatio(roomId);
  const ratioStr =
    samples >= MIN_SAMPLES
      ? `${Math.round(ratio * 100)}% engagement (${samples} proactive sends tracked)`
      : `not enough data yet (${samples}/${MIN_SAMPLES} proactive sends tracked)`;

  const lastAdjust = (autoAdjustLog.get(roomId) ?? []).at(-1);
  const adjustStr = lastAdjust
    ? `last auto-adjusted ${lastAdjust.direction === 'up' ? 'quieter ↑' : 'more active ↓'} ` +
      `(${lastAdjust.from.toFixed(2)} → ${lastAdjust.to.toFixed(2)})`
    : null;

  const patterns = getWatchPatterns(roomId);

  return { effective, source, ratioStr, adjustStr, userOverride, roomOverride, patterns };
}

// ── Internal ──────────────────────────────────────────────────────────────────

function engagementRatio(roomId) {
  const log = proactiveLogs.get(roomId) ?? [];
  if (!log.length) return 0;
  return log.filter((e) => e.engaged).length / log.length;
}

function runAutoAdjust(roomId) {
  if (explicitOverrides.has(roomId)) return; // explicit preset/threshold takes priority

  const log = proactiveLogs.get(roomId) ?? [];
  if (log.length < MIN_SAMPLES) return;

  const ratio = engagementRatio(roomId);
  const current = autoThresholds.get(roomId) ?? null;

  let next = current;
  if (ratio < 0.2) {
    next = clamp((current ?? 0.6) + ADJUST_STEP); // too noisy → quieter
  } else if (ratio > 0.6) {
    next = clamp((current ?? 0.6) - ADJUST_STEP); // undercontributing → more active
  }

  if (next !== null && next !== current) {
    autoThresholds.set(roomId, next);
    const adjLog = autoAdjustLog.get(roomId) ?? [];
    adjLog.push({
      ts: Date.now(),
      direction: next > (current ?? 0.6) ? 'up' : 'down',
      from: current ?? 0.6,
      to: next,
    });
    if (adjLog.length > 5) adjLog.shift();
    autoAdjustLog.set(roomId, adjLog);
  }
}

module.exports = {
  PRESETS,
  // Room
  setOverride,
  clearOverride,
  getOverride,
  setPreset,
  // User
  setUserOverride,
  clearUserOverride,
  getUserOverride,
  setUserPreset,
  // Threshold
  getEffectiveThreshold,
  getPresetName,
  // Engagement
  recordProactiveSend,
  recordHumanMessage,
  // Watch patterns
  addWatchPattern,
  removeWatchPattern,
  clearWatchPatterns,
  getWatchPatterns,
  shouldNotify,
  // Status
  getStatus,
};
