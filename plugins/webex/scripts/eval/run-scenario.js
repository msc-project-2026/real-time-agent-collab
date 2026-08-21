// ********* SCRIPTS/EVAL/RUN-SCENARIO.JS *********
'use strict';

// Synthetic evaluation runner.
//
// Runs a scenario JSON object through the real collaboration pipeline without
// calling any Webex APIs.  Builds hydrated Webex-like message objects from the
// scenario and passes them directly into handleHydratedWebexMessage — the point
// immediately after a real webhook would have fetched a message from /messages/:id.
//
// The full pipeline runs unchanged via the existing dispatch machinery:
//   routing → conversation processing → item extraction → recall
//
// This module requires the OpenClaw plugin runtime to already be initialised
// (i.e. the webex plugin must have been registered) so that getPluginRuntime()
// returns a live runtime with real agent dispatch.  The intended usage is via the
// eval HTTP route (eval/router.js) on a running OpenClaw instance.
//
// Webex-specific external effects that are bypassed:
//   - Webex API fetch             — skipped by entering at handleHydratedWebexMessage
//   - Webex membership check      — skipped for the same reason
//   - Webex send (recall/config)  — captureSend is injected as sendFn;
//                                   outbound sends are collected and returned
//
// expectedRoute and other scenario labels are NOT used to drive execution.
// They are carried in routingDecisions for later comparison and scoring.

const fs = require('node:fs/promises');
const path = require('node:path');

const { handleHydratedWebexMessage } = require('../../inbound/message');
const { handleStagePendingBatchRequest } = require('../../batch/staging-handler');
const { setEvalMode } = require('../../batch/eval-mode');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByRound(messages) {
  const rounds = new Map();
  for (const msg of messages) {
    const r = msg.round;
    if (!rounds.has(r)) rounds.set(r, []);
    rounds.get(r).push(msg);
  }
  return [...rounds.entries()].sort(([a], [b]) => a - b);
}

function stableTimestamp(number) {
  return new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString();
}

function buildSyntheticMessage({ scenario, scenarioMsg, participants, botId, numberToId }) {
  const participant = participants[scenarioMsg.sender];
  const id = numberToId(scenarioMsg.number);
  const parentId = scenarioMsg.replyTo != null ? numberToId(scenarioMsg.replyTo) : undefined;

  const mentionedPeople = [];
  if (typeof scenarioMsg.text === 'string' && scenarioMsg.text.includes('@Collaboration')) {
    mentionedPeople.push(botId);
  }

  return {
    id,
    roomId: scenario.spaceId,
    roomType: 'group',
    text: scenarioMsg.text ?? '',
    markdown: scenarioMsg.text ?? '',
    personId: participant?.personId ?? scenarioMsg.sender.toLowerCase(),
    personEmail: participant?.email ?? `${scenarioMsg.sender.toLowerCase()}@example.test`,
    senderName: participant?.name ?? scenarioMsg.sender,
    created: stableTimestamp(scenarioMsg.number),
    ...(parentId != null ? { parentId } : {}),
    mentionedPeople,
    // Scenario metadata carried through for output; not read by pipeline logic.
    _eval: {
      scenarioId: scenario.id,
      scenarioMessageNumber: scenarioMsg.number,
      round: scenarioMsg.round,
      where: scenarioMsg.where,
      expectedRoute: scenarioMsg.expectedRoute,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Wait for all session queues belonging to a space to go idle.
//
// dispatchToAgent() fires onJobCompletion as a fire-and-forget promise.
// That callback may itself enqueue further dispatches (conv-processing, item
// extraction).  Each session type has its own queue keyed as `${spaceId}:<type>`.
// Poll until all keys prefixed with `${spaceId}:` have been continuously absent
// for debounceMs, which covers the brief gap between consecutive dispatches.
// ---------------------------------------------------------------------------

async function waitForSpaceIdle(spaceId, { debounceMs = 2000, timeoutMs = 600000 } = {}) {
  const { dispatchQueues } = require('../../dispatch');
  const prefix = `${spaceId}:`;
  const deadline = Date.now() + timeoutMs;
  let idleSince = null;

  function hasActiveQueues() {
    for (const key of dispatchQueues.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  while (Date.now() < deadline) {
    if (hasActiveQueues()) {
      idleSince = null;
      await sleep(100);
    } else {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= debounceMs) return;
      await sleep(100);
    }
  }

  throw new Error(`[eval] dispatch for space ${spaceId} did not become idle within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function makeCollectingLogger(runLog, externalLog) {
  function collect(level, msg, meta) {
    runLog.push({ level, ts: new Date().toISOString(), msg, ...(meta != null ? { meta } : {}) });
  }
  return {
    info: (msg, meta) => { collect('info', msg, meta); externalLog?.info?.(msg, meta); },
    warn: (msg, meta) => { collect('warn', msg, meta); externalLog?.warn?.(msg, meta); },
    error: (msg, meta) => { collect('error', msg, meta); externalLog?.error?.(msg, meta); },
  };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// runScenario — main exported function
//
// Parameters:
//   scenario   Scenario object (id, spaceId, participants[], messages[])
//   options    { clearPrevious: bool } — delete prior space data before run
//   log        Optional external logger ({ info, warn, error }) for server-side
//              output.  All entries are always collected in runLog regardless.
//
// Returns a result bundle:
//   { scenarioId, items, conversations, threads, routingDecisions,
//     recallResponses, timings, runLog }
// ---------------------------------------------------------------------------

async function runScenario({ scenario, options = {}, log: externalLog } = {}) {
  if (!scenario?.id) throw new Error('scenario.id is required');
  if (!scenario.spaceId) throw new Error('scenario.spaceId is required');
  if (!Array.isArray(scenario.participants)) throw new Error('scenario.participants must be an array');
  if (!Array.isArray(scenario.messages)) throw new Error('scenario.messages must be an array');

  const { spaceDir, itemsPath, conversationsPath, threadsPath } = require('../../storage/paths');

  // clearPrevious defaults to true. Refuse to wipe a non-eval space.
  const clearPrevious = options.clearPrevious !== false;
  if (clearPrevious) {
    if (!scenario.spaceId.startsWith('eval-')) {
      throw new Error(
        `[eval] refusing to clear non-eval space "${scenario.spaceId}". spaceId must start with "eval-".`
      );
    }
    await fs.rm(spaceDir(scenario.spaceId), { recursive: true, force: true });
  }

  const runLog = [];
  const capturedSends = [];
  const log = makeCollectingLogger(runLog, externalLog);

  // captureSend is local to this run — concurrent calls don't share state.
  // Recall and config handlers check account.config.token before calling sendFn,
  // so the eval account sets a non-empty sentinel to pass that guard.
  async function captureSend({ to, markdown, text, parentId }) {
    capturedSends.push({
      ts: new Date().toISOString(),
      to,
      markdown: markdown ?? text ?? '',
      ...(parentId != null ? { parentId } : {}),
    });
    return { id: `eval-captured-${Date.now()}` };
  }

  log.info(`[eval] starting scenario`, { scenarioId: scenario.id, clearPrevious });

  const participants = {};
  for (const p of scenario.participants) participants[p.name] = p;

  const BOT_ID = 'eval-bot';
  const numberToId = (n) => `${scenario.id}-msg-${n}`;

  const syntheticMsgById = new Map();
  for (const scenarioMsg of scenario.messages) {
    const synthetic = buildSyntheticMessage({
      scenario,
      scenarioMsg,
      participants,
      botId: BOT_ID,
      numberToId,
    });
    syntheticMsgById.set(synthetic.id, synthetic);
  }

  // routingDecisions carries scenario-declared expected routes per message.
  // Actual routes chosen by the model appear in runLog entries.
  const routingDecisions = scenario.messages.map((msg) => ({
    messageNumber: msg.number,
    messageId: numberToId(msg.number),
    round: msg.round,
    sender: msg.sender,
    expectedRoute: msg.expectedRoute ?? null,
  }));

  const account = { accountId: 'eval', config: { token: 'eval-no-send' } };

  const timings = {
    scenarioId: scenario.id,
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalMs: null,
    rounds: [],
  };

  // Suppress automatic batch staging (deferred timer and task_request immediate path)
  // for the duration of this run. The eval runner controls staging at round boundaries.
  setEvalMode(true);

  const startMs = Date.now();
  const rounds = groupByRound(scenario.messages);

  try {
    for (const [round, roundMsgs] of rounds) {
      const roundStart = Date.now();
      const roundTimings = {
        round,
        messages: [],
        routingIdleMs: null,
        stagingDurationMs: null,
        processingIdleMs: null,
        totalRoundMs: null,
      };

      log.info(`[eval] round ${round} started`, { messageCount: roundMsgs.length });

      for (const scenarioMsg of roundMsgs) {
        const synthetic = syntheticMsgById.get(numberToId(scenarioMsg.number));

        log.info(`[eval] processing message`, {
          number: scenarioMsg.number,
          sender: scenarioMsg.sender,
          expectedRoute: scenarioMsg.expectedRoute,
        });

        const msgStart = Date.now();

        await handleHydratedWebexMessage({
          message: synthetic,
          botId: BOT_ID,
          account,
          log,
          // fetchMessageById resolves parent messages from the synthetic message map,
          // used by appendMessageToThreadWindow to seed thread context windows.
          fetchMessageById: async (id) => {
            const msg = syntheticMsgById.get(id);
            if (!msg) throw new Error(`[eval] synthetic message not found: ${id}`);
            return msg;
          },
          sendFn: captureSend,
        });

        roundTimings.messages.push({
          number: scenarioMsg.number,
          id: synthetic.id,
          durationMs: Date.now() - msgStart,
        });
      }

      log.info(`[eval] round ${round} messages submitted`, { count: roundMsgs.length });

      // Wait for routing dispatch queues (and their fire-and-forget onSessionComplete
      // chains) to drain before forcing staging.
      const routingWaitStart = Date.now();
      await waitForSpaceIdle(scenario.spaceId);
      roundTimings.routingIdleMs = Date.now() - routingWaitStart;
      log.info(`[eval] round ${round} routing idle`, { routingIdleMs: roundTimings.routingIdleMs });

      // Force staging for this round. handleStagePendingBatchRequest awaits the
      // conv-processing dispatch, but item extraction is fire-and-forget from within it.
      log.info(`[eval] round ${round} staging started`);
      const stagingStart = Date.now();
      await handleStagePendingBatchRequest({ spaceId: scenario.spaceId, account, log });
      roundTimings.stagingDurationMs = Date.now() - stagingStart;
      log.info(`[eval] round ${round} staging completed`, { stagingDurationMs: roundTimings.stagingDurationMs });

      // Wait for conv-processing → item-extraction dispatch chains to fully settle
      // before starting the next round.
      const processingWaitStart = Date.now();
      await waitForSpaceIdle(scenario.spaceId);
      roundTimings.processingIdleMs = Date.now() - processingWaitStart;
      log.info(`[eval] round ${round} processing idle`, { processingIdleMs: roundTimings.processingIdleMs });

      roundTimings.totalRoundMs = Date.now() - roundStart;
      timings.rounds.push(roundTimings);
      log.info(`[eval] round ${round} complete`, {
        totalRoundMs: roundTimings.totalRoundMs,
        routingIdleMs: roundTimings.routingIdleMs,
        stagingDurationMs: roundTimings.stagingDurationMs,
        processingIdleMs: roundTimings.processingIdleMs,
      });
    }
  } finally {
    setEvalMode(false);
  }

  timings.completedAt = new Date().toISOString();
  timings.totalMs = Date.now() - startMs;

  const items = await readJsonIfExists(itemsPath(scenario.spaceId));
  const conversations = await readJsonIfExists(conversationsPath(scenario.spaceId));
  const threads = await readJsonIfExists(threadsPath(scenario.spaceId));

  log.info(`[eval] scenario complete`, {
    scenarioId: scenario.id,
    totalMs: timings.totalMs,
    itemCount: items?.length ?? 0,
    conversationCount: conversations?.length ?? 0,
  });

  return {
    scenarioId: scenario.id,
    items: items ?? [],
    conversations: conversations ?? [],
    threads: threads ?? [],
    routingDecisions,
    recallResponses: capturedSends,
    timings,
    runLog,
  };
}

module.exports = { runScenario };

// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly as a script.
//
// Requires the OpenClaw gateway to be running with the webex plugin registered.
// Writes the result bundle as individual files to evaluation/outputs/<id>/.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const PLUGIN_ROOT = path.join(__dirname, '..', '..');
  const [, , scenarioArg] = process.argv;

  if (!scenarioArg) {
    console.error(
      'Usage: node plugins/webex/scripts/eval/run-scenario.js <scenario.json>'
    );
    process.exit(1);
  }

  const cliLog = {
    info: (msg, meta) => console.log('[eval:info]', msg, meta ?? ''),
    warn: (msg, meta) => console.warn('[eval:warn]', msg, meta ?? ''),
    error: (msg, meta) => console.error('[eval:error]', msg, meta ?? ''),
  };

  (async () => {
    const scenarioRaw = await fs.readFile(path.resolve(scenarioArg), 'utf8');
    const scenario = JSON.parse(scenarioRaw);

    const result = await runScenario({ scenario, options: { clearPrevious: true }, log: cliLog });

    const outputDir = path.join(PLUGIN_ROOT, 'evaluation', 'outputs', scenario.id);
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });

    const writeJson = (name, data) =>
      fs.writeFile(path.join(outputDir, name), JSON.stringify(data, null, 2) + '\n', 'utf8');

    await writeJson('response.json', result);
    if (result.items.length) await writeJson('items.json', result.items);
    if (result.conversations.length) await writeJson('conversations.json', result.conversations);
    if (result.threads.length) await writeJson('threads.json', result.threads);
    if (result.routingDecisions.length) await writeJson('routing-decisions.json', result.routingDecisions);
    if (result.recallResponses.length) await writeJson('recall-responses.json', result.recallResponses);
    await writeJson('timings.json', result.timings);
    await writeJson('run-log.json', result.runLog);

    console.log(`\n[eval] outputs written to: ${outputDir}`);
  })()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[eval] fatal error:', err);
      process.exit(1);
    });
}
