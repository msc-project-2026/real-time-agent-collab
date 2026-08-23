// ********* PROCESSING/SEARCH-TASKS-TOOL.JS *********
'use strict';

// v3 §7c — lets a step look up a task mentioned by name that isn't already
// in the current active-task injection (e.g. an archived one, or one from a
// thread outside this run's window). Read-only, no pending-result map needed
// — returns its result directly.

const { searchTasks } = require('../storage/tasks-store');

function searchTasksTool() {
  return {
    name: 'search_tasks',
    description:
      'Look up tasks by keyword when one is referenced that is not already listed in your active-tasks context. Searches task type, assignee, and id.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description: 'The spaceId from the prompt. Copy it verbatim.',
        },
        query: {
          type: 'string',
          description: 'Keyword to search for.',
        },
        includeArchived: {
          type: 'boolean',
          description: 'Defaults to true — set false to search only active tasks.',
        },
      },
      required: ['spaceId', 'query'],
      additionalProperties: false,
    },
    async execute(_toolUseId, params) {
      const { spaceId, query, includeArchived } = params ?? {};

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
        const tasks = await searchTasks({
          spaceId,
          query,
          includeArchived: includeArchived ?? true,
        });

        return { ok: true, tasks };
      } catch (err) {
        return { ok: false, errors: [err?.message ?? String(err)] };
      }
    },
  };
}

module.exports = {
  searchTasksTool,
};
