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

function tagMessageTool() {
  return {
    name: 'tag_message',
    description:
      "Record the tagging gate's classification of a thread's pending slice (v3 §4). Call this tool once successfully. If it returns { ok: false }, correct the parameters and retry (up to 3 attempts total). Do not answer the user or call any other tool.",
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
            'Semantic addressing — is the pending slice addressed to the bot, independent of the deterministic mention flag.',
        },
        configRequest: {
          type: 'boolean',
          description:
            'Semantic detection of a config ask, falling back to slash-command syntax where applicable.',
        },
        ready: {
          type: 'boolean',
          description:
            'Whether the pending slice already contains a complete, coherent unit of meaning worth acting on.',
        },
        reason: {
          type: 'string',
          description: 'A brief reason for the `ready` judgment.',
        },
      },
      required: [
        'spaceId',
        'threadKey',
        'isAddressed',
        'configRequest',
        'ready',
        'reason',
      ],
      additionalProperties: false,
    },
    async execute(_toolUseId, params) {
      const { spaceId, threadKey, isAddressed, configRequest, ready, reason } =
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
      if (typeof ready !== 'boolean') {
        errors.push('`ready` must be a boolean.');
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
          '[webex:tag_message] overwriting pending result (tool called more than once)',
          { spaceId, threadKey }
        );
      }

      pendingTagResults.set(key, {
        messageTags: { isAddressed, configRequest },
        pendingThreadWindowDecision: { ready, reason },
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
