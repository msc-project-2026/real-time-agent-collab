// ********* EVAL/SCORE/SCORE-TASKS.JS *********
'use strict';

// Deterministic structural scoring of task extraction.
//
// Matching is by `message_ids` overlap, not by title. Titles are free text
// and vary run to run for the same task ("Fix export button label mismatch"
// vs "Rename the export button to export filtered results"), so matching on
// them would report spurious misses. The evidence a task cites is the stable
// identity signal, and the fixture states it explicitly per expected task.
// Title fidelity is judged separately (score-tasks-judge.js) once a pair has
// been matched here.
//
// Normalised-title overlap is used only to break ties when one observed task
// overlaps two expected tasks equally, which happens when a thread's messages
// legitimately support more than one task.

function normaliseTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function titleOverlap(a, b) {
  const left = new Set(normaliseTitle(a));
  const right = normaliseTitle(b);
  if (left.size === 0 || right.length === 0) return 0;
  const hits = right.filter((w) => left.has(w)).length;
  return hits / Math.max(left.size, right.length);
}

// Fixture evidence is message *numbers*; observed evidence is message ids.
function expectedMessageIds(expected, scenarioId) {
  return (expected.evidenceMessages ?? []).map((n) => `${scenarioId}-msg-${n}`);
}

function overlapCount(observedIds, expectedIds) {
  const set = new Set(observedIds ?? []);
  return (expectedIds ?? []).filter((id) => set.has(id)).length;
}

// bundle: the object written by eval/run-scenario.js.
function scoreTasks(bundle) {
  const scenario = bundle?.scenario ?? {};
  const scenarioId = scenario.id ?? 'unknown';
  const expectedTasks = Array.isArray(scenario.expectedTasks) ? scenario.expectedTasks : [];
  const observedTasks = Array.isArray(bundle?.tasks) ? bundle.tasks : [];
  const updates = Array.isArray(scenario.updates) ? scenario.updates : [];

  // Greedy best-first matching: score every pair, take the strongest
  // remaining pair until nothing overlaps. Greedy is sufficient at fixture
  // sizes of a handful of tasks and keeps the result explainable, which
  // matters more here than optimality.
  const pairs = [];
  for (const expected of expectedTasks) {
    const expIds = expectedMessageIds(expected, scenarioId);
    for (const observed of observedTasks) {
      const overlap = overlapCount(observed.message_ids, expIds);
      if (overlap === 0) continue;
      pairs.push({
        expected,
        observed,
        overlap,
        tiebreak: titleOverlap(expected.title, observed.title),
      });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap || b.tiebreak - a.tiebreak);

  const usedExpected = new Set();
  const usedObserved = new Set();
  const matched = [];

  for (const pair of pairs) {
    if (usedExpected.has(pair.expected.id) || usedObserved.has(pair.observed.id)) continue;
    usedExpected.add(pair.expected.id);
    usedObserved.add(pair.observed.id);

    const fields = {};
    for (const [field, expectedValue] of [
      ['type', pair.expected.type],
      ['status', pair.expected.expectedStatus],
      ['assigned', pair.expected.expectedAssigned],
    ]) {
      if (expectedValue === undefined) continue;
      const observedValue = pair.observed[field];
      fields[field] = {
        expected: expectedValue,
        observed: observedValue ?? null,
        correct: observedValue === expectedValue,
      };
    }

    matched.push({
      expectedId: pair.expected.id,
      observedId: pair.observed.id,
      expectedTitle: pair.expected.title,
      observedTitle: pair.observed.title,
      observedDescription: pair.observed.description ?? null,
      evidenceOverlap: pair.overlap,
      expectedMessageIds: expectedMessageIds(pair.expected, scenarioId),
      observedMessageIds: pair.observed.message_ids ?? [],
      fields,
      fieldsCorrect: Object.values(fields).every((f) => f.correct),
    });
  }

  const missing = expectedTasks
    .filter((e) => !usedExpected.has(e.id))
    .map((e) => ({ expectedId: e.id, title: e.title }));
  const spurious = observedTasks
    .filter((o) => !usedObserved.has(o.id))
    .map((o) => ({ observedId: o.id, title: o.title, message_ids: o.message_ids ?? [] }));

  // An update is a hit when the matched task ends at the expected status AND
  // cites the message that caused the change — status alone would pass a task
  // that reached `done` for an unrelated reason.
  const updateResults = updates.map((update) => {
    const pair = matched.find((m) => m.expectedId === update.taskId);
    const afterId = `${scenarioId}-msg-${update.afterMessage}`;
    if (!pair) {
      return { ...update, hit: false, reason: 'expected task was not matched' };
    }
    const statusOk = pair.fields.status ? pair.fields.status.observed === update.expectedStatus : false;
    const citesTrigger = (pair.observedMessageIds ?? []).includes(afterId);
    return {
      taskId: update.taskId,
      afterMessage: update.afterMessage,
      expectedStatus: update.expectedStatus,
      observedStatus: pair.fields.status?.observed ?? null,
      statusOk,
      citesTrigger,
      hit: statusOk && citesTrigger,
    };
  });

  const fieldTotals = {};
  for (const pair of matched) {
    for (const [field, result] of Object.entries(pair.fields)) {
      fieldTotals[field] = fieldTotals[field] ?? { correct: 0, total: 0 };
      fieldTotals[field].total += 1;
      if (result.correct) fieldTotals[field].correct += 1;
    }
  }

  return {
    matched,
    missing,
    spurious,
    updates: updateResults,
    overall: {
      expected: expectedTasks.length,
      observed: observedTasks.length,
      matched: matched.length,
      missing: missing.length,
      spurious: spurious.length,
      fieldsAllCorrect: matched.filter((m) => m.fieldsCorrect).length,
      byField: fieldTotals,
      updateHits: updateResults.filter((u) => u.hit).length,
      updateTotal: updateResults.length,
    },
  };
}

module.exports = { scoreTasks, normaliseTitle, titleOverlap };
