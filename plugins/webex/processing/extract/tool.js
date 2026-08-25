// ********* PROCESSING/EXTRACT/TOOL.JS *********
'use strict';

// v3 §7c task schema (phase 6) — single upsert tool for the extract step.
// Unlike tag_message (gate/tool.js), this tool's job IS the side effect:
// it writes straight through to storage/tasks-store.js and returns the
// result, no pending-result map to read back afterward — extract's own
// completion is enough of a signal that whatever it wrote already landed.

const {
  upsertTask,
  readTasksState,
  CONFIDENCE_AUTO_APPROVE_THRESHOLD,
} = require('../../storage/tasks-store');

// Mirrors board/src/App.jsx's own dummy delegation-target mapping — same
// literal target strings, so a task reads consistently whether seen via the
// task-notify ack message or later on the board.
const DEFAULT_DELEGATION_TARGET_BY_TYPE = {
  development: 'dev-swarm',
  design: 'design-agent',
  research: 'research-agent',
};

// Closed positive taxonomy (response-policy + extraction-calibration
// revision): development | design | research are the only task-worthy
// categories — see extract/instruction.js's "How to extract" section for
// the full definition of each. `coordination` was dropped: it was too
// permissive a catch-all, letting non-deliverables (decisions, questions)
// get extracted as tasks.
const ALLOWED_TYPES = new Set(['development', 'design', 'research']);
// v3 §7c status enum, board-workflow revision: `open`/`approved`/`delegated`
// replaced by `unapproved` (pre-approval, drives the Review Queue) plus a
// traditional post-approval pipeline (backlog/in_progress/in_review/done).
// Delegation is no longer a status value — it's a board-local action/target
// (see board/src/App.jsx), not tracked here.
const ALLOWED_STATUSES = new Set([
  'unapproved',
  'backlog',
  'in_progress',
  'in_review',
  'done',
  'archived',
]);

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
          description:
            'For a task assigned to a human (or unassigned): set this only if the thread clearly shows real progress already exists (e.g. already started or already done) — otherwise omit it and the default applies. For a task assigned to the agent itself ("agent"): never set this — pass `confidence` instead, and the system decides the outcome deterministically.',
        },
        confidence: {
          type: 'number',
          description:
            'Only when `assigned` is "agent": your confidence (0-1) that this self-assigned task is genuinely warranted, weighing both how explicitly you were directed and how well it fits a safe, clearly in-scope pickup. Omit entirely when assigning to a human or leaving unassigned.',
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
        confidence,
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
      if (
        confidence !== undefined &&
        (typeof confidence !== 'number' || confidence < 0 || confidence > 1)
      ) {
        errors.push('`confidence` must be a number between 0 and 1.');
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
        // Captured before the write so the auto-approval override below can
        // tell "just created" / "was still unapproved" apart from "already
        // past unapproved" — a patch is a separate upsertTask call from the
        // read, but they run inside the extract:${spaceId} lock (see
        // flow/run-message-flow.js), so there's no concurrent-write race here.
        const priorStatus = id
          ? ((await readTasksState({ spaceId })).tasks.find((existing) => existing.id === id)
              ?.status ?? null)
          : 'unapproved';

        let task = await upsertTask({
          spaceId,
          id,
          patch: {
            title,
            description,
            type,
            assigned,
            deadline,
            status,
            confidence,
            message_ids: messageIds,
            child_tasks: childTasks,
          },
        });

        // Confidence-driven auto-approval (response-policy + extraction-
        // calibration revision): a self-assigned task that clears the
        // threshold skips human approval and starts immediately. Guarded to
        // only ever fire once, on first crossing the bar — without the
        // priorStatus === 'unapproved' check, a later legitimate patch (e.g.
        // marking an already-in-flight task `done`) that happens to also
        // carry a high confidence value could get silently reset back to
        // `in_progress`.
        if (
          task.assigned === 'agent' &&
          typeof task.confidence === 'number' &&
          task.confidence >= CONFIDENCE_AUTO_APPROVE_THRESHOLD &&
          priorStatus === 'unapproved'
        ) {
          task = await upsertTask({
            spaceId,
            id: task.id,
            patch: {
              status: 'in_progress',
              delegation: {
                target: DEFAULT_DELEGATION_TARGET_BY_TYPE[task.type] ?? 'dev-swarm',
                delegatedAt: new Date().toISOString(),
              },
            },
          });
        }

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
