// ********* PROCESSING/SEARCH-RECALL-TOOL.JS *********
'use strict';

// v3 §9 recall — shared query tool for both `respond` (on-demand recall
// during an answer) and `summarize` (finding a supersession candidate
// anywhere in the space). One implementation, no special-casing between the
// two call sites: embeds the model's own query text (avoids the batch-text-
// vs-summary-text embedding mismatch a deterministic controller-side
// pre-fetch would have), ranks space-wide rather than thread-filtered (see
// recall/similarity.js), and always returns full supersession chains rather
// than resolving down to a single head — so the calling model can judge
// recency itself, the same way write_task's active-vs-superseded task
// decisions are already left to the model rather than hardcoded.

const { readRecallEntries, getSupersedingChain } = require('../storage/recall-store');
const { rankRecallEntries } = require('../recall/similarity');
const { embed } = require('../embeddings/client');
const { getPluginRuntime } = require('../runtime');

function formatRecallEntry(entry) {
  return {
    id: entry.id,
    thread_id: entry.thread_id,
    summary_text: entry.summary_text,
    keywords: entry.keywords,
    message_ids: entry.message_ids,
    created_at: entry.created_at,
  };
}

function searchRecallTool() {
  return {
    name: 'search_recall',
    description:
      "Semantically search this space's recall index of prior batch summaries. Searches the whole space, not just the current thread — relevant history from another thread can still be returned. Each match is returned together with everything that supersedes it, so you can judge from the timestamps which version is actually current.",
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description: 'The spaceId from the prompt. Copy it verbatim.',
        },
        query: {
          type: 'string',
          description: "What you're looking for, in your own words.",
        },
        threadId: {
          type: 'string',
          description:
            'The current threadId, if known — used only to lightly favor same-thread matches, never to exclude other threads.',
        },
      },
      required: ['spaceId', 'query'],
      additionalProperties: false,
    },
    async execute(_toolUseId, params) {
      const { spaceId, query, threadId } = params ?? {};

      const errors = [];
      if (!spaceId || typeof spaceId !== 'string') {
        errors.push('`spaceId` must be a non-empty string.');
      }
      if (!query || typeof query !== 'string' || !query.trim()) {
        errors.push('`query` must be a non-empty string.');
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      try {
        const pluginRuntime = getPluginRuntime();
        const [queryEmbedding] = await embed([query], { pluginRuntime });

        const entries = await readRecallEntries({ spaceId });
        const matches = rankRecallEntries({
          entries,
          queryEmbedding,
          queryText: query,
          threadId,
        });

        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const seen = new Set();
        const results = [];

        for (const match of matches) {
          if (!seen.has(match.id)) {
            seen.add(match.id);
            results.push(formatRecallEntry(match));
          }

          // Merge in everything that supersedes this match too — two
          // independently top-ranked matches can share a member further
          // down their own chains, so dedupe by id rather than risk
          // returning the same entry twice.
          const chainIds = await getSupersedingChain(match.id, { spaceId });
          for (const chainId of chainIds) {
            if (seen.has(chainId)) continue;
            seen.add(chainId);
            const chainEntry = byId.get(chainId);
            if (chainEntry) results.push(formatRecallEntry(chainEntry));
          }
        }

        return { ok: true, results };
      } catch (err) {
        return { ok: false, errors: [err?.message ?? String(err)] };
      }
    },
  };
}

module.exports = {
  searchRecallTool,
};
