'use strict';

// Per-room and per-user proactivity state.
//
// Threshold priority (highest → lowest):
//   1. User override  (/collab me quiet)     — per-person, overrides everything
//   2. Room override  (/collab quiet)         — room-wide explicit setting
//   3. Auto-adjusted                          — computed from engagement history
//   4. Config default (gateThreshold)         — openclaw.json baseline

// ── Room-level state ──────────────────────────────────────────────────────────

// Map<roomId, number> — from /collab commands
const explicitOverrides = new Map();

// Map<roomId, number> — computed from engagement, never overwrites explicit
const autoThresholds = new Map();

// Map<roomId, Array<{ sentAt: ms, engaged: bool }>>
const proactiveLogs = new Map();

// ── User-level state ──────────────────────────────────────────────────────────

// Map<personId, number> — from /collab me commands
const userOverrides = new Map();

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

// ── Effective threshold ───────────────────────────────────────────────────────

// personId is optional — pass it to apply user-level override.
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

// ── Status (for /collab status) ───────────────────────────────────────────────

function getStatus(roomId, baseThreshold, personId = null) {
  const userOverride = personId ? getUserOverride(personId) : null;
  const roomOverride = getOverride(roomId);
  const auto = autoThresholds.get(roomId);
  const effective = getEffectiveThreshold(roomId, baseThreshold, personId);

  const source =
    userOverride != null ? 'your personal override' :
    roomOverride != null ? 'room override' :
    auto != null         ? 'auto-adjusted' :
                           'config default';

  const samples = (proactiveLogs.get(roomId) ?? []).length;
  const ratio = engagementRatio(roomId);
  const ratioStr =
    samples >= MIN_SAMPLES
      ? `${Math.round(ratio * 100)}% engagement (${samples} proactive sends tracked)`
      : `not enough data yet (${samples}/${MIN_SAMPLES} proactive sends tracked)`;

  return { effective, source, ratioStr, userOverride, roomOverride };
}

// ── Internal ──────────────────────────────────────────────────────────────────

function engagementRatio(roomId) {
  const log = proactiveLogs.get(roomId) ?? [];
  if (!log.length) return 0;
  return log.filter((e) => e.engaged).length / log.length;
}

function runAutoAdjust(roomId) {
  if (explicitOverrides.has(roomId)) return; // explicit override takes priority

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
  }
}

module.exports = {
  // Room
  setOverride,
  clearOverride,
  getOverride,
  // User
  setUserOverride,
  clearUserOverride,
  getUserOverride,
  // Threshold
  getEffectiveThreshold,
  // Engagement
  recordProactiveSend,
  recordHumanMessage,
  // Status
  getStatus,
};
