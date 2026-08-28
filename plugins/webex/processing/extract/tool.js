// ********* PROCESSING/EXTRACT/TOOL.JS *********
'use strict';

// v3 §7c task schema (phase 6) — single upsert tool for the extract step.
// Unlike submit_gate_decision (gate/tool.js), this tool's job IS the side effect:
// it writes straight through to storage/tasks-store.js and returns the
// result, no pending-result map to read back afterward — extract's own
// completion is enough of a signal that whatever it wrote already landed.

const {
  upsertTask,
  readTasksState,
  CONFIDENCE_AUTO_APPROVE_THRESHOLD,
} = require('../../storage/tasks-store');
const { readActiveConfig } = require('../../config/store');
const { looksLikeSpaceId } = require('../../storage/paths');

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

// Self-claim strength, replacing a model-authored 0-1 `confidence` float.
//
// The model was asked to compress a three-band judgment into a number, which
// we then re-expanded against proactivityThreshold. That round trip was the
// single noisiest part of the pipeline: two identical eval runs of the same
// scenario produced 0.6 and 0.75 for the same task, straddling the 0.7 bar,
// so the agent held the task for review on one run and auto-started it on the
// other. LLMs are poorly calibrated at emitting numeric self-confidence, and
// a hard threshold turns that noise into a coin flip on the highest-stakes
// decision in the system.
//
// The model now names the band directly and this table does the mapping. The
// values are chosen so the existing per-space thresholds keep their meaning
// exactly: Conservative (0.85) and Balanced (0.7) auto-approve only
// `directed`; Proactive (0.5) also auto-approves `reasonable`; `speculative`
// never auto-approves under any supported setting. Tasks still store a
// numeric `confidence`, so the board and any downstream reader are unchanged.
const ALLOWED_CLAIMS = new Set(['directed', 'reasonable', 'speculative']);
const CLAIM_CONFIDENCE = {
  directed: 0.9,
  reasonable: 0.6,
  speculative: 0.2,
};
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
          description:
            'Short human-readable summary. Required when creating a task.',
        },
        description: {
          type: 'string',
          description: 'Optional longer elaboration.',
        },
        type: {
          type: 'string',
          enum: [...ALLOWED_TYPES],
          description:
            'Required when creating a task. The kind of work this task represents.',
        },
        assigned: {
          type: 'string',
          description:
            'Required when creating a task. The member id this task belongs to, taken from the space members list — the id, never a name. Use "agent" to claim it yourself when no member has been given it or claimed it.',
        },
        deadline: {
          type: 'string',
          description: 'ISO datetime, if a deadline was actually stated.',
        },
        status: {
          type: 'string',
          enum: [...ALLOWED_STATUSES],
          description:
            'For a task assigned to a member: set this only if the thread clearly shows real progress already exists (e.g. already started or already done) — otherwise omit it and the default applies. For a task assigned to the agent itself ("agent"): never set this — pass `claim` instead, and the system decides the outcome deterministically.',
        },
        claim: {
          type: 'string',
          enum: [...ALLOWED_CLAIMS],
          description:
            'Required when creating a task with `assigned` set to "agent". How strongly this work was handed to you: "directed" if you were explicitly asked to do it, "reasonable" if picking it up is a sensible, low-risk fit for the conversation, "speculative" if it is ambiguous or higher-stakes. Omit for a task assigned to a member.',
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Message ids that are direct evidence for this task. Accumulates — do not repeat ids already recorded.',
        },
        child_tasks: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Existing task ids that are sub-tasks of this one. Accumulates. Rejected if it would create a cycle.',
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
        claim,
        message_ids: messageIds,
        child_tasks: childTasks,
      } = params ?? {};

      // Fixed value per band — never a model-authored float. See
      // CLAIM_CONFIDENCE above for why.
      const confidence = claim !== undefined ? CLAIM_CONFIDENCE[claim] : undefined;

      const errors = [];

      if (!spaceId || typeof spaceId !== 'string') {
        errors.push('`spaceId` must be a non-empty string.');
      } else if (!looksLikeSpaceId(spaceId)) {
        errors.push(
          "`spaceId` does not look like a real space id — copy it verbatim from the prompt's spaceId fact, never guess or reconstruct it."
        );
      }
      if (!id && !title) {
        errors.push(
          '`title` is required when creating a task (no `id` given).'
        );
      }
      if (!id && !type) {
        errors.push('`type` is required when creating a task (no `id` given).');
      }
      // Required on create only — a patch (id given) must not have to restate
      // ownership just to append message_ids. Enforced here rather than via
      // the schema's `required` for that reason. Both were previously
      // optional, and the first eval run showed the model omitting them on
      // every task, leaving upsertTask's `assigned: 'unknown'` default
      // standing in for an ownership decision that was never made.
      if (!id && !assigned) {
        errors.push(
          '`assigned` is required when creating a task (no `id` given) — a member id from the space members list, or "agent" to claim it yourself.'
        );
      }
      // Only meaningful for a self-claim: a member-assigned task needs no
      // band, and requiring a throwaway one just invites the model to invent
      // a value it has no basis for.
      if (!id && assigned === 'agent' && claim === undefined) {
        errors.push(
          `\`claim\` is required when creating a task assigned to "agent" — one of: ${[...ALLOWED_CLAIMS].join(', ')}.`
        );
      }
      if (type !== undefined && !ALLOWED_TYPES.has(type)) {
        errors.push(
          `\`type\` must be one of: ${[...ALLOWED_TYPES].join(', ')}.`
        );
      }
      if (status !== undefined && !ALLOWED_STATUSES.has(status)) {
        errors.push(
          `\`status\` must be one of: ${[...ALLOWED_STATUSES].join(', ')}.`
        );
      }
      if (claim !== undefined && !ALLOWED_CLAIMS.has(claim)) {
        errors.push(
          `\`claim\` must be one of: ${[...ALLOWED_CLAIMS].join(', ')}.`
        );
      }
      if (messageIds !== undefined && !Array.isArray(messageIds)) {
        errors.push('`message_ids` must be an array of strings.');
      }
      if (childTasks !== undefined && !Array.isArray(childTasks)) {
        errors.push('`child_tasks` must be an array of strings.');
      }

      if (errors.length > 0) {
        // write_task's execute() has no threaded `log` — writeTaskTool() is
        // instantiated once at plugin registration (index.js), not per
        // spawn, so there's no flowId/log to close over. Unlike the job-log
        // file (flow/job-log.js, one entry per *step*, written by the
        // orchestrator after the whole spawn completes), a validation
        // rejection happens per *tool call* and was previously invisible
        // anywhere — the model just silently retried or gave up, with
        // nothing for us to diagnose after the fact. console.warn here
        // reaches the same log aggregation everything else does, and is
        // correlatable by timestamp against the surrounding job-log entries.
        console.warn(
          `[collab-agent:write-task] rejected: invalid parameters ${JSON.stringify(
            {
              params,
              errors,
            }
          )}`
        );
        return { ok: false, errors };
      }

      try {
        // Captured before the write so the auto-approval override below can
        // tell "just created" / "was still unapproved" apart from "already
        // past unapproved" — a patch is a separate upsertTask call from the
        // read, but they run inside the extract:${spaceId} lock (see
        // flow/run-message-flow.js), so there's no concurrent-write race here.
        const priorStatus = id
          ? ((await readTasksState({ spaceId })).tasks.find(
              (existing) => existing.id === id
            )?.status ?? null)
          : 'unapproved';

        // Creating a task with no explicit status: default to 'backlog' for
        // a human-assigned (or unassigned) task, since there's no approval
        // step for those — a human simply owns it. Self-assigned-to-agent
        // tasks keep upsertTask's own 'unapproved' default (leave status
        // unset here), since that's what the confidence auto-approval
        // override below depends on. Patching an existing task is untouched
        // either way — omitting status there already preserves the prior
        // value in upsertTask.
        const effectiveStatus =
          status !== undefined
            ? status
            : !id && assigned !== 'agent'
              ? 'backlog'
              : undefined;

        let task = await upsertTask({
          spaceId,
          id,
          patch: {
            title,
            description,
            type,
            assigned,
            deadline,
            status: effectiveStatus,
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
        //
        // Threshold is per-space configurable (config card consolidation) —
        // the space's own proactivityThreshold if it's ever been set,
        // otherwise tasks-store.js's documented default.
        const activeConfig = await readActiveConfig({ spaceId });
        const confidenceThreshold =
          activeConfig?.config?.proactivityThreshold ??
          CONFIDENCE_AUTO_APPROVE_THRESHOLD;

        if (
          task.assigned === 'agent' &&
          typeof task.confidence === 'number' &&
          task.confidence >= confidenceThreshold &&
          priorStatus === 'unapproved'
        ) {
          task = await upsertTask({
            spaceId,
            id: task.id,
            patch: {
              status: 'in_progress',
              delegation: {
                target:
                  DEFAULT_DELEGATION_TARGET_BY_TYPE[task.type] ?? 'dev-swarm',
                delegatedAt: new Date().toISOString(),
              },
            },
          });
        }

        return { ok: true, task };
      } catch (err) {
        console.warn(
          `[collab-agent:write-task] rejected: threw during write ${JSON.stringify(
            {
              params,
              error: err?.message ?? String(err),
              stack: err?.stack ?? null,
            }
          )}`
        );
        return { ok: false, errors: [err?.message ?? String(err)] };
      }
    },
  };
}

module.exports = {
  writeTaskTool,
};
