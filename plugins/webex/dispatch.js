// ********* DISPATCH.JS *********
'use strict';

// Serialise dispatch per Webex space
const dispatchQueues = new Map();
const DISPATCH_SETTLE_DELAY_MS = 500;

function sleep(ms = DISPATCH_SETTLE_DELAY_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueSpaceDispatch(spaceId, job) {
  const previous = dispatchQueues.get(spaceId) ?? Promise.resolve();

  console.log('[webex] enqueue dispatch', {
    spaceId,
    alreadyQueued: dispatchQueues.has(spaceId),
  });

  const next = previous
    .catch((err) => {
      // Keep the queue alive even if the previous dispatch failed.
      console.warn('[webex] previous dispatch failed; continuing queue', {
        spaceId,
        error: err?.message ?? String(err),
      });
    })
    .then(async () => {
      console.log('[webex] start dispatch', { spaceId });
      try {
        return await job();
      } finally {
        await sleep();
      }
    })
    .finally(() => {
      console.log('[webex] finish dispatch', { spaceId });
      if (dispatchQueues.get(spaceId) === next) {
        dispatchQueues.delete(spaceId);
      }
    });

  dispatchQueues.set(spaceId, next);
  return next;
}

async function dispatchWithSessionConflictRetry(dispatchJob) {
  // On gateway restart, an existing OpenClaw reply session can transiently
  // fail initialization for the canonical room SessionKey. Retry once with a
  // temporary recovery SessionKey so the inbound message is not lost. Later
  // messages still use the canonical SessionKey.
  try {
    return await dispatchJob();
  } catch (err) {
    const message = err?.message ?? String(err);

    if (!message.includes('reply session initialization conflicted')) {
      throw err;
    }

    const recoverySuffix = `recovery-${Date.now()}`;

    console.warn(
      '[webex] reply session conflict; retrying once with recovery session key',
      {
        error: message,
        recoverySuffix,
      }
    );

    await sleep(500);

    return await dispatchJob(recoverySuffix);
  }
}

// *** Dispatch to agent for space
// (nested dispatch in dispatchWithRetry, itself nested in enqueuedDispatch call)
async function dispatchToAgentForSpace({
  pluginRuntime,
  spaceId,
  account,
  log,
  buildCtxPayload,
}) {
  const dispatch =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    log?.warn?.(
      `[webex:${account.accountId}] agent pipeline dispatch unavailable`
    );
    return;
  }

  const loadedCfg = pluginRuntime.config?.current?.() ?? {};

  await enqueueSpaceDispatch(spaceId, () =>
    dispatchWithSessionConflictRetry((sessionKeySuffix) =>
      dispatch({
        ctx: buildCtxPayload(sessionKeySuffix),
        cfg: loadedCfg,
        dispatcherOptions: {
          deliver: async (out) => {
            if (!out.text) return;
            log?.info?.(
              `[webex:${account.accountId}] agent output suppressed: ${out.text}`
            );
          },
          onError: (err) => {
            log?.error?.(
              `[webex:${account.accountId}] reply dispatch error: ${err?.message ?? err}`
            );
          },
        },
        replyOptions: {},
      })
    )
  );
}

module.exports = {
  dispatchToAgentForSpace,
};
