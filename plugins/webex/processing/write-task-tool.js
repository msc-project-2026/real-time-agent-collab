// ********* PROCESSING/WRITE-TASK-TOOL.JS *********
'use strict';

// v3 §7c task schema (phase 6) — single upsert tool for the extract step.
// Unlike tag_message (tagging/tool.js), this tool's job IS the side effect:
// it writes straight through to context/tasks-store.js and returns the
// result, no pending-result map to read back afterward — extract's own
// completion is enough of a signal that whatever it wrote already landed.

const { upsertTask } = require('../context/tasks-store');

// Open taxonomy per v3 §7c ("development | design | research | ..."), but a
// starter allowlist is enforced here (at the tool layer, not the store —
// context/tasks-store.js stays type-agnostic) so extraction stays on a small,
// consistent set rather than drifting into free-form labels turn by turn.
const ALLOWED_TYPES = new Set(['development', 'design', 'research', 'coordination']);
const ALLOWED_STATUSES = new Set(['open', 'approved', 'delegated', 'done', 'archived']);

function writeTaskTool() {
  return {
    name: 'write_task',
    description:
      'Create a new task or update an existing one. Omit `id` to create; pass an existing `id` to patch it — only the fields you pass change, message_ids and child_tasks accumulate rather than replace. Call this once per task-worthy point you find. If it returns { ok: false }, correct the parameters and retry.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description: 'The spaceId from the prompt. Copy it verbatim.',
        },
        id: {
          type: 'string',
          description: 'Existing task id to patch. Omit to create a new task.',
        },
        title: {
          type: 'string',
          description: 'Short human-readable summary. Required when creating a task.',
        },
        description: {
          type: 'string',
          description: 'Optional longer elaboration.',
        },
        type: {
          type: 'string',
          enum: [...ALLOWED_TYPES],
          description: 'Required when creating a task. The kind of work this task represents.',
        },
        assigned: {
          type: 'string',
          description: 'The member or sender id this task is assigned to, if known.',
        },
        deadline: {
          type: 'string',
          description: 'ISO datetime, if a deadline was actually stated.',
        },
        status: {
          type: 'string',
          enum: [...ALLOWED_STATUSES],
          description: 'Defaults to "open" when creating. Only pass this to change status on a patch.',
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message ids that are direct evidence for this task. Accumulates — do not repeat ids already recorded.',
        },
        child_tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Existing task ids that are sub-tasks of this one. Accumulates. Rejected if it would create a cycle.',
        },
      },
      required: ['spaceId'],
      additionalProperties: false,
    },
    async execute(_toolUseId, params) {
      const {
        spaceId,
        id,
        title,
        description,
        type,
        assigned,
        deadline,
        status,
        message_ids: messageIds,
        child_tasks: childTasks,
      } = params ?? {};

      const errors = [];

      if (!spaceId || typeof spaceId !== 'string') {
        errors.push('`spaceId` must be a non-empty string.');
      }
      if (!id && !title) {
        errors.push('`title` is required when creating a task (no `id` given).');
      }
      if (!id && !type) {
        errors.push('`type` is required when creating a task (no `id` given).');
      }
      if (type !== undefined && !ALLOWED_TYPES.has(type)) {
        errors.push(`\`type\` must be one of: ${[...ALLOWED_TYPES].join(', ')}.`);
      }
      if (status !== undefined && !ALLOWED_STATUSES.has(status)) {
        errors.push(`\`status\` must be one of: ${[...ALLOWED_STATUSES].join(', ')}.`);
      }
      if (messageIds !== undefined && !Array.isArray(messageIds)) {
        errors.push('`message_ids` must be an array of strings.');
      }
      if (childTasks !== undefined && !Array.isArray(childTasks)) {
        errors.push('`child_tasks` must be an array of strings.');
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      try {
        const task = await upsertTask({
          spaceId,
          id,
          patch: {
            title,
            description,
            type,
            assigned,
            deadline,
            status,
            message_ids: messageIds,
            child_tasks: childTasks,
          },
        });

        return { ok: true, task };
      } catch (err) {
        return { ok: false, errors: [err?.message ?? String(err)] };
      }
    },
  };
}

module.exports = {
  writeTaskTool,
};
