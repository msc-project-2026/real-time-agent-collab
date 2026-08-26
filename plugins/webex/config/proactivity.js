// ********* CONFIG/PROACTIVITY.JS *********
'use strict';

// Shared between config/card.js (renders the choice list) and
// config/handle-submission.js (validates against the same set) — an
// Adaptive Card has no native slider, so the closest simple fit is a small
// set of labeled discrete levels rather than a raw numeric entry (avoids
// asking a non-technical user to pick "0.62" out of nowhere). Replaces the
// old, fully-unused `responseMode` field.

// Re-exported, not redefined — tasks-store.js's CONFIDENCE_AUTO_APPROVE_THRESHOLD
// is the one source of truth for the fallback default; this module only adds
// the discrete-level UI/validation mapping on top of it.
const { CONFIDENCE_AUTO_APPROVE_THRESHOLD } = require('../storage/tasks-store');

const PROACTIVITY_LEVELS = [
  { title: 'Conservative', value: 0.85 },
  { title: 'Balanced (default)', value: CONFIDENCE_AUTO_APPROVE_THRESHOLD },
  { title: 'Proactive', value: 0.5 },
];

module.exports = {
  PROACTIVITY_LEVELS,
  DEFAULT_PROACTIVITY_THRESHOLD: CONFIDENCE_AUTO_APPROVE_THRESHOLD,
};
