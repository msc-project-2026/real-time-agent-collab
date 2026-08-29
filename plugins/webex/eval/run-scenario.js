// ********* EVAL/RUN-SCENARIO.JS *********
'use strict';

// Phase 8 synthetic evaluation runner, rebuilt against the v3 pipeline
// (flow/run-message-flow.js). Runs a scenario JSON through the real
// collaboration pipeline **without touching any Webex API** — it enters at
// inbound/message.js's `handleHydratedWebexMessage`, the exact seam a real
// webhook reaches after fetching the message body, and injects:
//   - `fetchMessageById` → resolves parent messages from the synthetic map
//   - `sendFn` → captures outbound sends instead of calling Webex
//
// Unlike the pre-v3 runner this replaces, dispatch is now fully awaited inside
// runMessageFlow (gate under a lock, extract ∥ summarize via allSettled,
// task-notify, then respond) — so there is no fire-and-forget dispatch to
// poll for and no round-grouping. Messages are fed strictly in order and each
// runMessageFlow call is awaited to completion before the next.
//
// Requires a live plugin runtime (real runEmbeddedAgent + tasks.flow) — it is
// driven in-gateway via the `webex.eval.run` gateway method
// (eval/gateway-method.js), invoked with `openclaw gateway call` from the
// deployment. It cannot run as a standalone script or a plugin CLI subcommand:
// both load without a plugin runtime in this gateway version.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { handleHydratedWebexMessage } = require('../inbound/message');
const { writeActiveConfig, writeCachedMembers } = require('../config/store');
const { readJobLogEntries } = require('../flow/job-log');
const { summarizeUsage } = require('../processing/usage/summary');
const { readTasksState } = require('../storage/tasks-store');
const { readRecallEntries } = require('../storage/recall-store');
const { getThreads } = require('../storage/threads-store');
const { setOutboundOverride } = require('../send');
const { webexPlugin } = require('../channel');
const { getPluginRuntime } = require('../runtime');
const {
  spaceDir,
  taggingValidationLogPath,
  getWorkspaceRoot,
} = require('../storage/paths');

const FALLBACK_BOT_ID = 'eval-bot';

// The real bot's personId, resolved from the live account. Using it rather
// than a synthetic id keeps a single bot identity across the whole run:
// inbound self-filtering, thread-window routing (`message.personId === botId`
// decides processed vs pending) and `fromAgent` in every prompt all compare
// against the same value. channel.js caches it at startup, so it is populated
// inside the gateway and null anywhere else — hence the fallback.
function resolveBotId() {
  try {
    const cfg = getPluginRuntime().config.current();
    return webexPlugin.config.resolveAccount(cfg)?.botId ?? FALLBACK_BOT_ID;
  } catch {
    return FALLBACK_BOT_ID;
  }
}
const MENTION_MARKERS = ['@Collaboration', '@collab', '@Collab', '@bot'];
const EVAL_URN_MARKER = ':eval/ROOM/';

// A real Webex spaceId is base64 of a ciscospark:// URN containing /ROOM/ —
// storage/paths.js's looksLikeSpaceId() and send.js's buildMsgBody both
// enforce that shape, and write_task/search_tasks reject anything else. Give
// the eval space an id in that exact shape, tagged `:eval/ROOM/` so the
// clear-before-run guard can tell an eval space apart from a real one.
function encodeEvalSpaceId(scenarioId) {
  const safe = String(scenarioId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return Buffer.from(`ciscospark://urn:TEAM:eval/ROOM/${safe}`).toString('base64');
}

function isEvalSpaceId(spaceId) {
  try {
    return Buffer.from(String(spaceId), 'base64')
      .toString('utf-8')
      .includes(EVAL_URN_MARKER);
  } catch {
    return false;
  }
}

function stableTimestamp(number) {
  // Monotonic, deterministic, one second apart — matches the pre-v3 runner.
  return new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString();
}

function hasMention(text) {
  return (
    typeof text === 'string' &&
    MENTION_MARKERS.some((marker) => text.includes(marker))
  );
}

function buildSyntheticMessage({ scenarioMsg, spaceId, participants, numberToId, botId }) {
  const participant = participants[scenarioMsg.sender];
  const id = numberToId(scenarioMsg.number);
  const parentId =
    scenarioMsg.replyTo != null ? numberToId(scenarioMsg.replyTo) : undefined;

  return {
    id,
    roomId: spaceId,
    roomType: 'group',
    text: scenarioMsg.text ?? '',
    markdown: scenarioMsg.text ?? '',
    personId: participant?.personId ?? String(scenarioMsg.sender).toLowerCase(),
    personEmail:
      participant?.email ?? `${String(scenarioMsg.sender).toLowerCase()}@eval.test`,
    senderName: participant?.name ?? scenarioMsg.sender,
    created: stableTimestamp(scenarioMsg.number),
    ...(parentId != null ? { parentId } : {}),
    mentionedPeople: hasMention(scenarioMsg.text) ? [botId] : [],
    _eval: {
      number: scenarioMsg.number,
      round: scenarioMsg.round ?? null,
      where: scenarioMsg.where ?? null,
      expectedRoute: scenarioMsg.expectedRoute ?? null,
    },
  };
}

function makeCollectingLogger(runLog, externalLog) {
  const collect = (level, msg, meta) => {
    runLog.push({
      level,
      ts: new Date().toISOString(),
      msg: typeof msg === 'string' ? msg : JSON.stringify(msg),
      ...(meta != null ? { meta } : {}),
    });
  };
  return {
    info: (msg, meta) => { collect('info', msg, meta); externalLog?.info?.(msg, meta); },
    warn: (msg, meta) => { collect('warn', msg, meta); externalLog?.warn?.(msg, meta); },
    error: (msg, meta) => { collect('error', msg, meta); externalLog?.error?.(msg, meta); },
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function readJsonlIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function currentGitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// runScenario — the exported entry point (called by eval/router.js).
//
//   scenario   parsed scenario JSON (id, participants[], messages[], plus
//              expected* fixture fields the scorers read later)
//   variant    label for a comparison arm — 'baseline' by default; recorded
//              in the bundle so variants archive side by side
//   overrides  { proactivityThreshold?, githubRepo? } seeded into the eval
//              space's synthetic config
//   log        optional external logger; every line is also collected
//
// Returns the full result bundle. Also writes it to disk under
//   eval/outputs/<scenario.id>/<variant>/<evalRunId>/
// ---------------------------------------------------------------------------
async function runScenario({ scenario, variant = 'baseline', overrides = {}, log: externalLog } = {}) {
  if (!scenario?.id) throw new Error('scenario.id is required');
  if (!Array.isArray(scenario.participants)) {
    throw new Error('scenario.participants must be an array');
  }
  if (!Array.isArray(scenario.messages)) {
    throw new Error('scenario.messages must be an array');
  }

  const evalRunId = randomUUID();
  const spaceId = encodeEvalSpaceId(scenario.id);

  // Guard: never wipe a space that isn't an eval space.
  if (!isEvalSpaceId(spaceId)) {
    throw new Error(`[eval] refusing to run — derived spaceId is not an eval space`);
  }
  await fs.rm(spaceDir(spaceId), { recursive: true, force: true });

  const runLog = [];
  const log = makeCollectingLogger(runLog, externalLog);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  log.info('[eval] starting scenario', { scenarioId: scenario.id, variant, evalRunId });

  // -- seed synthetic config + members so gate/extract/respond can resolve
  //    space members and a proactivity threshold, exactly as a real space would.
  await writeActiveConfig({
    spaceId,
    source: 'eval',
    config: {
      proactivityThreshold: overrides.proactivityThreshold ?? 0.7,
      githubRepo: overrides.githubRepo ?? null,
    },
  });
  await writeCachedMembers({
    spaceId,
    members: scenario.participants.map((p) => ({
      id: p.personId,
      name: p.name,
      source: 'webex',
    })),
  });

  const participants = {};
  for (const p of scenario.participants) participants[p.name] = p;

  const numberToId = (n) => `${scenario.id}-msg-${n}`;

  const syntheticById = new Map();
  for (const scenarioMsg of scenario.messages) {
    const synthetic = buildSyntheticMessage({
      scenarioMsg,
      spaceId,
      participants,
      numberToId,
      botId,
    });
    syntheticById.set(synthetic.id, synthetic);
  }

  const botId = resolveBotId();
  log.info('[eval] resolved bot identity', {
    botId,
    synthetic: botId === FALLBACK_BOT_ID,
  });

  const capturedSends = [];
  let currentMessageNumber = null;

  // Registered against this run's spaceId only (send.js), so it intercepts
  // every sender in the plugin — including the respond step's own `message`
  // tool call, which no injected `sendFn` can reach — while real spaces keep
  // hitting Webex untouched.
  //
  // The synthetic reply is stamped with the same `botId` the caller is about
  // to record against, so appendMessageToThreadWindow routes it to
  // `processed` as bot-authored rather than into `pending` as a user turn.
  async function captureSend({ to, markdown, text, parentId, spaceId: sendSpaceId, botId, attachments } = {}) {
    const n = capturedSends.length + 1;
    capturedSends.push({
      ts: new Date().toISOString(),
      forMessageNumber: currentMessageNumber,
      to: to ?? sendSpaceId ?? null,
      markdown: markdown ?? text ?? '',
      parentId: parentId ?? null,
      isCard: Array.isArray(attachments) && attachments.length > 0,
    });
    return {
      id: `eval-sent-${n}`,
      roomId: sendSpaceId ?? to,
      roomType: 'group',
      personId: botId,
      personEmail: 'collab-agent@eval.test',
      text: markdown ?? text ?? '',
      markdown: markdown ?? text ?? '',
      created: new Date().toISOString(),
      ...(parentId != null ? { parentId } : {}),
      mentionedPeople: [],
    };
  }

  // eval account — a non-empty sentinel token passes the `account.config.token`
  // guard senders check before calling sendFn; botWebhookUrl origin only feeds
  // deriveBoardUrl (returns a harmless eval URL).
  const account = {
    accountId: 'eval',
    config: { token: 'eval-no-send', botWebhookUrl: 'https://eval.local/' },
  };

  const messageTimings = [];

  setOutboundOverride({ spaceId, fn: captureSend });

  try {
  for (const scenarioMsg of scenario.messages) {
    const synthetic = syntheticById.get(numberToId(scenarioMsg.number));
    currentMessageNumber = scenarioMsg.number;
    const msgStart = Date.now();

    log.info('[eval] processing message', {
      number: scenarioMsg.number,
      sender: scenarioMsg.sender,
      expectedRoute: scenarioMsg.expectedRoute ?? null,
    });

    try {
      await handleHydratedWebexMessage({
        message: synthetic,
        botId,
        account,
        log,
        fetchMessageById: async (id) => {
          const msg = syntheticById.get(id);
          if (!msg) throw new Error(`[eval] synthetic message not found: ${id}`);
          return msg;
        },
      });
    } catch (err) {
      log.error('[eval] message processing threw', {
        number: scenarioMsg.number,
        error: err?.message ?? String(err),
      });
    }

    messageTimings.push({
      number: scenarioMsg.number,
      id: synthetic.id,
      durationMs: Date.now() - msgStart,
    });
  }
  } finally {
    // Cleared even if a message throws — a stale override would silently
    // swallow this space's real traffic for the rest of the process's life.
    setOutboundOverride(null);
  }
  currentMessageNumber = null;

  // -- collect final state from disk --
  const tasksState = await readTasksState({ spaceId });
  const recallEntries = await readRecallEntries({ spaceId });
  const threads = await getThreads({ spaceId, limit: 1000 });
  const jobs = await readJobLogEntries({ spaceId });
  const gateValidation = await readJsonlIfExists(taggingValidationLogPath(spaceId));
  const usageSummary = summarizeUsage(jobs);

  const completedAt = new Date().toISOString();
  const totalMs = Date.now() - startMs;

  const meta = {
    scenarioId: scenario.id,
    variant,
    evalRunId,
    spaceId,
    startedAt,
    completedAt,
    totalMs,
    gitSha: currentGitSha(),
    messageCount: scenario.messages.length,
  };

  const bundle = {
    meta,
    scenario,
    threads,
    tasks: tasksState.tasks ?? [],
    recall: recallEntries,
    jobs,
    usageSummary,
    sends: capturedSends,
    gateValidation,
    messageTimings,
    runLog,
  };

  // Bundles go on the persistent volume, not next to this file. __dirname is
  // under /app, the container's image layer, which is replaced wholesale on
  // every deploy — a full session's runs were lost that way before this was
  // noticed. getWorkspaceRoot() resolves the mounted volume, the same place
  // every other piece of durable state already lives.
  const outputDir = path.join(
    getWorkspaceRoot(),
    'eval-outputs',
    scenario.id,
    variant,
    evalRunId
  );
  await fs.mkdir(outputDir, { recursive: true });
  const writeJson = (name, data) =>
    fs.writeFile(
      path.join(outputDir, name),
      `${JSON.stringify(data, null, 2)}\n`,
      'utf8'
    );

  await writeJson('bundle.json', bundle);
  await writeJson('meta.json', meta);
  await writeJson('threads.json', threads);
  await writeJson('tasks.json', bundle.tasks);
  await writeJson('jobs.json', jobs);
  await writeJson('usage-summary.json', usageSummary);
  await writeJson('sends.json', capturedSends);
  await writeJson('gate-validation.json', gateValidation);

  log.info('[eval] scenario complete', {
    scenarioId: scenario.id,
    variant,
    evalRunId,
    totalMs,
    taskCount: bundle.tasks.length,
    recallCount: recallEntries.length,
    sends: capturedSends.length,
    tokensTotal: usageSummary.total.total,
    outputDir,
  });

  return { ...bundle, outputDir };
}

module.exports = {
  runScenario,
  encodeEvalSpaceId,
  isEvalSpaceId,
  buildSyntheticMessage,
  resolveBotId,
  FALLBACK_BOT_ID,
};
