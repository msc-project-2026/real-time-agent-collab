// ********* DISPATCH.JS *********
'use strict';

// Serialise dispatch per session queue key (e.g. `${spaceId}:routing`).
// Each session type maintains its own independent queue so routing, recall,
// conv-processing, and item-extraction sessions serialise within their own
// type without blocking one another.
const dispatchQueues = new Map();
const DISPATCH_SETTLE_DELAY_MS = 500;

function sleep(ms = DISPATCH_SETTLE_DELAY_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueSessionDispatch(queueKey, job) {
  const previous = dispatchQueues.get(queueKey) ?? Promise.resolve();

  console.log('[webex] enqueue dispatch', {
    queueKey,
    alreadyQueued: dispatchQueues.has(queueKey),
  });

  const next = previous
    .catch((err) => {
      // Keep the queue alive even if the previous dispatch failed.
      console.warn('[webex] previous dispatch failed; continuing queue', {
        queueKey,
        error: err?.message ?? String(err),
      });
    })
    .then(async () => {
      console.log('[webex] start dispatch', { queueKey });
      try {
        return await job();
      } finally {
        await sleep();
      }
    })
    .finally(() => {
      console.log('[webex] finish dispatch', { queueKey });
      if (dispatchQueues.get(queueKey) === next) {
        dispatchQueues.delete(queueKey);
      }
    });

  dispatchQueues.set(queueKey, next);
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

// *** Dispatch an agent job into its session queue.
// queueKey is the serialisation key — callers pass `${spaceId}:<type>` (e.g.
// `${spaceId}:routing`) so each session type maintains its own independent queue.
// onJobCompletion fires once when the dispatch session ends, fire-and-forget.
async function dispatchToAgent({
  pluginRuntime,
  queueKey,
  account,
  log,
  buildCtxPayload,
  onAgentOutput,
  onJobCompletion,
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

  await enqueueSessionDispatch(queueKey, () =>
    dispatchWithSessionConflictRetry((sessionKeySuffix) => {
      function deliver(out) {
        if (!out.text) return;

        log?.info?.(
          `[webex:${account.accountId}] dispatched agent output: ${out.text}`
        );

        void Promise.resolve(
          onAgentOutput?.({ text: out.text, queueKey, account, log })
        ).catch((err) => {
          log?.error?.(
            `[webex:${account.accountId}] onAgentOutput handler failed: ${err?.message ?? err}`,
            { queueKey, error: err?.message ?? String(err) }
          );
        });
      }

      function onError(err) {
        log?.error?.(
          `[webex:${account.accountId}] reply dispatch error: ${err?.message ?? err}`
        );
      }

      const p = dispatch({
        ctx: buildCtxPayload(sessionKeySuffix),
        cfg: loadedCfg,
        dispatcherOptions: { deliver, onError },
        replyOptions: {},
      });

      // onJobCompletion chains on the dispatch promise itself.
      // dispatch() resolves once when the session ends, making this the
      // natural job-complete signal regardless of whether text was produced.
      void Promise.resolve(p)
        .then(() => onJobCompletion?.())
        .catch((err) => onError(err));

      return p;
    })
  );
}

module.exports = {
  dispatchToAgent,
  dispatchQueues,
};
