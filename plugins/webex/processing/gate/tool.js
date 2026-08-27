// ********* PROCESSING/GATE/TOOL.JS *********
'use strict';

// Pending validated tag results keyed by `${spaceId}:${threadKey}` — a thread
// is the gate's unit of scope (v3 §2, §4). Written by tool execute();
// consumed (and cleared) by takePendingTagResult().
const pendingTagResults = new Map();

function tagResultKey(spaceId, threadKey) {
  return `${spaceId}::${threadKey}`;
}

function takePendingTagResult(spaceId, threadKey) {
  const key = tagResultKey(spaceId, threadKey);
  const result = pendingTagResults.get(key) ?? null;
  pendingTagResults.delete(key);
  return result;
}

// Exposed for testing: seed a result without going through the tool.
function setPendingTagResult(spaceId, threadKey, result) {
  pendingTagResults.set(tagResultKey(spaceId, threadKey), result);
}

// The tool's own parameter is named `batchReady` — that's what the model
// sees and reasons about (see instruction.js's "batch" framing). Internally
// we keep calling the same concept `sliceReady` everywhere downstream
// (decide.js, run-message-flow.js, tests) — renamed right here, once, at
// the boundary, rather than rippling the rename through code the model
// never sees.
function tagMessageTool() {
  return {
    name: 'submit_gate_decision',
    description:
      "Submit the gate's decision for this thread: tags for the current message (isAddressed, configRequest) plus a readiness call for the whole batch (batchReady). Call this tool once successfully. If it returns { ok: false }, correct the parameters and retry (up to 3 attempts total). Do not answer the user or call any other tool.",
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description: 'The spaceId from the prompt. Copy it verbatim.',
        },
        threadKey: {
          type: 'string',
          description: 'The threadKey from the prompt. Copy it verbatim.',
        },
        isAddressed: {
          type: 'boolean',
          description:
            'Semantic addressing — is the current message addressed to you, independent of the deterministic mention flag.',
        },
        configRequest: {
          type: 'boolean',
          description:
            'Semantic detection of a config ask on the current message, falling back to slash-command syntax where applicable.',
        },
        batchReady: {
          type: 'boolean',
          description:
            'Whether the batch of new messages already contains something concrete and actionable, rather than an obvious in-progress fragment.',
        },
        reason: {
          type: 'string',
          description: 'A brief reason for the `batchReady` judgment.',
        },
      },
      required: [
        'spaceId',
        'threadKey',
        'isAddressed',
        'configRequest',
        'batchReady',
        'reason',
      ],
      additionalProperties: false,
    },
    async execute(_toolUseId, params) {
      const { spaceId, threadKey, isAddressed, configRequest, batchReady, reason } =
        params ?? {};

      const errors = [];

      if (!spaceId || typeof spaceId !== 'string') {
        errors.push('`spaceId` must be a non-empty string.');
      }
      if (!threadKey || typeof threadKey !== 'string') {
        errors.push('`threadKey` must be a non-empty string.');
      }
      if (typeof isAddressed !== 'boolean') {
        errors.push('`isAddressed` must be a boolean.');
      }
      if (typeof configRequest !== 'boolean') {
        errors.push('`configRequest` must be a boolean.');
      }
      if (typeof batchReady !== 'boolean') {
        errors.push('`batchReady` must be a boolean.');
      }
      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        errors.push('`reason` must be a non-empty string.');
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      const key = tagResultKey(spaceId, threadKey);
      if (pendingTagResults.has(key)) {
        console.warn(
          '[webex:submit_gate_decision] overwriting pending result (tool called more than once)',
          { spaceId, threadKey }
        );
      }

      pendingTagResults.set(key, {
        messageTags: { isAddressed, configRequest },
        pendingThreadWindowDecision: { sliceReady: batchReady, reason },
      });

      return { ok: true };
    },
  };
}

module.exports = {
  tagMessageTool,
  takePendingTagResult,
  setPendingTagResult,
};
