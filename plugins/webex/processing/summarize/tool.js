// ********* PROCESSING/SUMMARIZE/TOOL.JS *********
'use strict';

// v3 §9 recall — the summarize step's single write tool. Bundles the
// summary text, keywords, and any supersession decision into one call, same
// pattern as write_task (processing/extract/tool.js). Embeds the model's own
// summary_text here — a content-matched embedding, not the raw batch (see
// dispatch.js) — then appends the new entry and any supersession rows.
//
// Fails soft: an embeddings failure (e.g. a host forgot to configure
// memorySearch for the routing agent — see embeddings/client.js) returns
// { ok: false, errors } rather than throwing across the tool-call boundary,
// same pattern every tool in this plugin already follows. This is what keeps
// a misconfigured host's summarize turn "maintaining service" instead of
// crashing the step.

const { appendRecallEntry, appendSupersessionRow } = require('../../storage/recall-store');
const { embed } = require('../../embeddings/client');
const { getPluginRuntime } = require('../../runtime');

function writeSummaryTool() {
  return {
    name: 'write_summary',
    description:
      'Record a distilled summary of this batch for later recall. Call this once per batch, after inspecting any `search_recall` results for a prior summary this one should supersede. If it returns { ok: false }, correct the parameters and retry.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description: 'The spaceId from the prompt. Copy it verbatim.',
        },
        threadId: {
          type: 'string',
          description: 'The threadId from the prompt. Copy it verbatim.',
        },
        summaryText: {
          type: 'string',
          description: 'A distilled gist of the batch — not raw message text.',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description:
            "A few exact names, numbers, or specifics from the batch that a semantic search over the summary text alone might miss.",
        },
        messageIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message ids this summary distills. Required — direct evidence for this entry.',
        },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ids of prior recall entries (from search_recall results) that this summary replaces, if any. Omit if none.',
        },
      },
      required: ['spaceId', 'threadId', 'summaryText', 'messageIds'],
      additionalProperties: false,
    },
    async execute(_toolUseId, params) {
      const {
        spaceId,
        threadId,
        summaryText,
        keywords,
        messageIds,
        supersedes,
      } = params ?? {};

      const errors = [];

      if (!spaceId || typeof spaceId !== 'string') {
        errors.push('`spaceId` must be a non-empty string.');
      }
      if (!threadId || typeof threadId !== 'string') {
        errors.push('`threadId` must be a non-empty string.');
      }
      if (!summaryText || typeof summaryText !== 'string' || !summaryText.trim()) {
        errors.push('`summaryText` must be a non-empty string.');
      }
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        errors.push('`messageIds` must be a non-empty array.');
      }
      if (keywords !== undefined && !Array.isArray(keywords)) {
        errors.push('`keywords` must be an array of strings.');
      }
      if (supersedes !== undefined && !Array.isArray(supersedes)) {
        errors.push('`supersedes` must be an array of ids.');
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      try {
        const pluginRuntime = getPluginRuntime();
        const [embedding] = await embed([summaryText], { pluginRuntime });

        const entry = await appendRecallEntry({
          spaceId,
          threadId,
          summaryText,
          keywords,
          messageIds,
          embedding,
        });

        for (const oldId of supersedes ?? []) {
          await appendSupersessionRow({ spaceId, oldId, newId: entry.id });
        }

        return { ok: true, entry: { id: entry.id, thread_id: entry.thread_id } };
      } catch (err) {
        return { ok: false, errors: [err?.message ?? String(err)] };
      }
    },
  };
}

module.exports = {
  writeSummaryTool,
};
