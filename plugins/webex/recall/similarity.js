// ********* RECALL/SIMILARITY.JS *********
'use strict';

// v3 §9 recall ranking — brute-force cosine similarity over recall entries,
// hybrid-boosted by keyword overlap and same-thread proximity. Space-wide by
// design, not thread-filtered: relevant history from another thread in the
// same space should still be able to surface, so thread match is a ranking
// signal here, not an exclusionary filter (a deliberate deviation from §9's
// original "filtered by thread_id" text — see the doc correction). Brute
// force is deliberate too — no external vector DB; the doc explicitly
// expects index size isn't a practical problem at this project's scale, and
// this matches the plugin's existing "coarse first" pattern (tasks-store.js's
// searchTasks is the same kind of plain scan, not a real search index
// either). Revisitable later without a storage redesign if entry counts
// ever genuinely grow — the {id, embedding, metadata} shape doesn't change
// either way.
//
// Weights below are placeholders, tunable later against the phase-8 recall
// eval case (docs/phase-8-eval-plan.md §4.5), not hand-tuned now.

const THREAD_MATCH_BONUS = 0.05;
const KEYWORD_MATCH_BONUS = 0.02;

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function keywordOverlapCount(queryText, entryKeywords) {
  if (!Array.isArray(entryKeywords) || entryKeywords.length === 0) return 0;

  const haystack = String(queryText ?? '').toLowerCase();
  return entryKeywords.filter(
    (keyword) => typeof keyword === 'string' && keyword && haystack.includes(keyword.toLowerCase())
  ).length;
}

// Ranks `entries` against `queryEmbedding`, optionally boosted by keyword
// overlap with `queryText` and same-thread match with `threadId`. Returns
// entries sorted by descending score (top `limit`), each annotated with its
// own `_score` — informational only, not part of an entry's persisted shape.
function rankRecallEntries({ entries, queryEmbedding, queryText, threadId, limit = 5 }) {
  if (!Array.isArray(entries)) throw new Error('entries array is required');
  if (!Array.isArray(queryEmbedding)) throw new Error('queryEmbedding array is required');

  return entries
    .map((entry) => {
      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
      const threadBonus = threadId && entry.thread_id === threadId ? THREAD_MATCH_BONUS : 0;
      const keywordBonus = keywordOverlapCount(queryText, entry.keywords) * KEYWORD_MATCH_BONUS;

      return { entry, score: similarity + threadBonus + keywordBonus };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry, score }) => ({ ...entry, _score: score }));
}

module.exports = {
  cosineSimilarity,
  rankRecallEntries,
};
