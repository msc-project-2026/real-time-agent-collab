'use strict';

// Deterministic fault-injection experiments for the project evaluation.
//
// These tests exercise the real plugin orchestration, recovery, persistence,
// locking, and token-refresh code. Only external boundaries (Webex REST, the
// Browser SDK, scheduling, and the independently evaluated minutes pipeline)
// are faked. No test makes a live Webex request or calls an LLM.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createMeetingMinutesManager } = require('./meeting-minutes');
const { createOrchestrator } = require('./orchestrator');
const { createTokenStore } = require('./token');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => typeof data === 'string' ? data : '',
  };
}

function meeting({ id = 'meeting-1', kind = 'instant' } = {}) {
  return {
    id,
    roomId: 'room-1',
    title: 'Fault-injection meeting',
    meetingType: kind === 'instant' ? 'meeting' : 'meetingSeries',
    state: 'inProgress',
    sipUrl: `sip:${id}@webex.com`,
    start: '2026-08-30T10:00:00Z',
    end: '2026-08-30T10:30:00Z',
  };
}

function createFakeBrowserRuntime({ pauseJoin = false } = {}) {
  const calls = { init: [], join: [], leave: [], syncActive: 0 };
  return {
    calls,
    init: async (token) => { calls.init.push(token); },
    join: async (destination, type) => {
      calls.join.push({ destination, type });
      // A microtask pause makes concurrent webhook deliveries overlap at the
      // MeetingState lock rather than accidentally executing serially.
      if (pauseJoin) await Promise.resolve();
      return 'sdk-meeting-1';
    },
    leave: async () => { calls.leave.push(true); },
    syncActive: async () => {
      calls.syncActive += 1;
      return [];
    },
    startTranscription: async () => {},
    stopTranscription: async () => {},
    dispose: async () => {},
  };
}

function createTokenStoreStub(meetingFetch) {
  return {
    getToken: () => 'meeting-token',
    refresh: async () => 'meeting-token',
    meetingFetch,
  };
}

function baseConfig() {
  return { botToken: 'bot-token', pollIntervalMs: 999_999, joinTimeoutMs: 1_000 };
}

async function withBotFetch(run) {
  const originalFetch = global.fetch;
  const postedMessages = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/people/me')) return jsonResponse({ id: 'bot-id' });
    if (String(url).endsWith('/messages')) {
      postedMessages.push(JSON.parse(options.body));
      return jsonResponse({ id: `message-${postedMessages.length}` });
    }
    throw new Error(`unexpected bot fetch: ${url}`);
  };
  try {
    return await run(postedMessages);
  } finally {
    global.fetch = originalFetch;
  }
}

function createFakeScheduler() {
  const jobs = [];
  return {
    schedule(callback, delay) {
      const job = {
        delay,
        cleared: false,
        unref() {},
        async run() {
          if (job.cleared) throw new Error('attempted to run a cleared recovery job');
          job.cleared = true;
          await callback();
        },
      };
      jobs.push(job);
      return job;
    },
    clear(job) {
      job.cleared = true;
    },
    next() {
      return jobs.find((job) => !job.cleared) ?? null;
    },
  };
}

function temporaryWorkspace(t) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-fault-evaluation-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  return workspaceRoot;
}

function createRecoveryHarness({
  t,
  unavailableLookups = 0,
  recoveryDelayMs = 100,
  recoveryMaxDelayMs = 400,
  recoveryWindowMs = 10_000,
  workspaceRoot = temporaryWorkspace(t),
  clock = { now: Date.parse('2026-08-30T12:00:00Z') },
  scheduler = createFakeScheduler(),
  writes = [],
} = {}) {
  let transcriptLookups = 0;
  const manager = createMeetingMinutesManager({
    workspaceRoot,
    config: { recoveryDelayMs, recoveryMaxDelayMs, recoveryWindowMs },
    now: () => clock.now,
    scheduleFn: (callback, delay) => scheduler.schedule(callback, delay),
    clearScheduleFn: (job) => scheduler.clear(job),
    tokenStore: {
      meetingFetch: async (requestPath) => {
        if (requestPath.startsWith('/meetingTranscripts?')) {
          transcriptLookups += 1;
          return transcriptLookups <= unavailableLookups
            ? { items: [] }
            : { items: [{ id: 'transcript-1' }] };
        }
        if (requestPath.startsWith('/meetings/')) return meeting();
        throw new Error(`unexpected meeting fetch: ${requestPath}`);
      },
      meetingFetchText: async () => 'WEBVTT\n\n00:00.000 --> 00:02.000\nTest transcript.',
    },
    // The pipeline is deliberately outside this evaluation. The stub is an
    // observable hand-off boundary, not an assessment of generated minutes.
    summarizer: { summarize: async () => 'fixed downstream result' },
    minutesStore: {
      appendMeetingMinutes: async (input) => {
        writes.push(input);
        return { written: true, owner: 'test', repo: 'meeting-plugin' };
      },
    },
  });
  return {
    manager,
    scheduler,
    clock,
    writes,
    getTranscriptLookups: () => transcriptLookups,
  };
}

async function runNextRecovery(harness) {
  const scheduled = harness.scheduler.next();
  assert.ok(scheduled, 'a recovery attempt should be scheduled');
  harness.clock.now += scheduled.delay;
  await scheduled.run();
  return scheduled.delay;
}

async function waitFor(predicate, description) {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    // `webexFetch()` traverses several awaited layers before a 401 reaches
    // the token store. Yielding one event-loop turn is deterministic here:
    // there is no I/O, timer, or network dependency in the fake fetch.
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), `timed out waiting for ${description}`);
}

async function f1MissedStartWebhookRecoversAcrossMeetingKindsAndPollCycles() {
  for (const kind of ['instant', 'scheduled']) {
    for (const missedPollCycles of [1, 2]) {
      await withBotFetch(async () => {
        const currentMeeting = meeting({ id: `${kind}-${missedPollCycles}`, kind });
        let sweep = 0;
        const browserRuntime = createFakeBrowserRuntime();
        const orchestrator = createOrchestrator({
          cfg: baseConfig(),
          browserRuntime,
          tokenStore: createTokenStoreStub(async (requestPath) => {
            if (requestPath === '/people/me') return { id: 'meeting-person-id' };
            if (requestPath.startsWith('/memberships?')) return { items: [{ id: 'membership-1' }] };
            if (requestPath.startsWith('/meetings?')) {
              const isInstantQuery = requestPath.includes('meetingType=meeting');
              if (!isInstantQuery) sweep += 1;
              const visible = sweep > missedPollCycles;
              const belongsInThisQuery = kind === 'instant' ? isInstantQuery : !isInstantQuery;
              return { items: visible && belongsInThisQuery ? [currentMeeting] : [] };
            }
            throw new Error(`unexpected meeting fetch: ${requestPath}`);
          }),
        });

        await orchestrator.start();
        // No handleMeetingStarted call: the start webhook was deliberately lost.
        for (let attempt = 0; attempt <= missedPollCycles; attempt += 1) {
          await orchestrator.reconcile();
        }

        assert.equal(orchestrator.state.isJoined(currentMeeting.id), true, `${kind}, ${missedPollCycles} missed cycles`);
        assert.equal(browserRuntime.calls.join.length, 1, 'recovery may join once only');
        assert.deepEqual(browserRuntime.calls.join[0], {
          destination: currentMeeting.sipUrl,
          type: 'SIP_URI',
        });
        await orchestrator.dispose();
      });
    }
  }
}

async function f2TranscriptRecoveryHandlesDelayAndDeadlineExhaustion(t) {
  for (const unavailableLookups of [1, 2, 3]) {
    const harness = createRecoveryHarness({ t, unavailableLookups });
    await harness.manager.rememberMeeting(meeting());
    await harness.manager.handleMeetingEnded({ meetingId: 'meeting-1', roomId: 'room-1' });

    const observedDelays = [];
    for (let attempt = 0; attempt <= unavailableLookups; attempt += 1) {
      observedDelays.push(await runNextRecovery(harness));
    }

    assert.equal(harness.writes.length, 1, `transcript available after ${unavailableLookups} retry/retries is handed off once`);
    assert.equal(harness.getTranscriptLookups(), unavailableLookups + 1);
    assert.equal((await harness.manager.readJob('meeting-1')).status, 'processed');
    assert.deepEqual(
      observedDelays,
      unavailableLookups === 1 ? [100, 100]
        : unavailableLookups === 2 ? [100, 100, 200]
          : [100, 100, 200, 400],
      'recovery uses bounded exponential backoff'
    );
    harness.manager.dispose();
  }

  const exhausted = createRecoveryHarness({
    t,
    unavailableLookups: Number.POSITIVE_INFINITY,
    recoveryWindowMs: 250,
  });
  await exhausted.manager.rememberMeeting(meeting());
  await exhausted.manager.handleMeetingEnded({ meetingId: 'meeting-1', roomId: 'room-1' });
  await runNextRecovery(exhausted); // at t+100: unavailable, next retry at t+200
  await runNextRecovery(exhausted); // at t+200: unavailable, next retry at t+400
  await runNextRecovery(exhausted); // at t+400: deadline is exceeded, no lookup occurs

  assert.equal(exhausted.writes.length, 0, 'an unavailable transcript is never handed off');
  assert.equal(exhausted.getTranscriptLookups(), 2, 'recovery stops querying after its deadline');
  assert.equal((await exhausted.manager.readJob('meeting-1')).status, 'exhausted');
  exhausted.manager.dispose();
}

async function f3ConcurrentDuplicateEventsProduceSingleEffects(t) {
  for (const deliveries of [2, 5, 10]) {
    const transcriptHarness = createRecoveryHarness({ t });
    const transcriptResults = await Promise.all(
      Array.from({ length: deliveries }, () => transcriptHarness.manager.handleTranscriptCreated({
        data: { id: 'transcript-1', meetingId: 'meeting-1' },
      }))
    );
    assert.equal(transcriptHarness.writes.length, 1, `${deliveries} duplicate transcript events yield one hand-off`);
    assert.equal(transcriptHarness.getTranscriptLookups(), 0, 'the primary webhook supplies the transcript id directly');
    assert.equal(transcriptResults.filter((result) => result.processed).length, 1);
    assert.equal(transcriptResults.filter((result) => result.duplicate).length, deliveries - 1);
    transcriptHarness.manager.dispose();

    await withBotFetch(async () => {
      const browserRuntime = createFakeBrowserRuntime({ pauseJoin: true });
      const currentMeeting = meeting({ id: `duplicate-start-${deliveries}` });
      const orchestrator = createOrchestrator({
        cfg: baseConfig(),
        browserRuntime,
        tokenStore: createTokenStoreStub(async (requestPath) => {
          if (requestPath === '/people/me') return { id: 'meeting-person-id' };
          if (requestPath.startsWith('/memberships?')) return { items: [{ id: 'membership-1' }] };
          if (requestPath === `/meetings/${currentMeeting.id}`) return currentMeeting;
          throw new Error(`unexpected meeting fetch: ${requestPath}`);
        }),
      });
      await orchestrator.start();
      await Promise.all(
        Array.from({ length: deliveries }, () => orchestrator.handleMeetingStarted({ data: { id: currentMeeting.id } }))
      );
      assert.equal(browserRuntime.calls.join.length, 1, `${deliveries} duplicate start events yield one SDK join`);
      assert.equal(orchestrator.state.isJoined(currentMeeting.id), true);
      await orchestrator.dispose();
    });
  }
}

async function f4RestartResumesRecoveryBeforeAndAfterFailedAttempt(t) {
  for (const restartPoint of ['before-first-retry', 'after-one-failed-retry']) {
    const workspaceRoot = temporaryWorkspace(t);
    const clock = { now: Date.parse('2026-08-30T12:00:00Z') };
    const firstScheduler = createFakeScheduler();
    const writes = [];
    let transcriptAvailable = false;
    const commonDependencies = {
      workspaceRoot,
      config: { recoveryDelayMs: 100, recoveryMaxDelayMs: 400, recoveryWindowMs: 10_000 },
      now: () => clock.now,
      tokenStore: {
        meetingFetch: async (requestPath) => {
          if (requestPath.startsWith('/meetingTranscripts?')) {
            return transcriptAvailable ? { items: [{ id: 'transcript-1' }] } : { items: [] };
          }
          if (requestPath.startsWith('/meetings/')) return meeting();
          throw new Error(`unexpected meeting fetch: ${requestPath}`);
        },
        meetingFetchText: async () => 'WEBVTT\n\nRestart recovery transcript.',
      },
      summarizer: { summarize: async () => 'fixed downstream result' },
      minutesStore: {
        appendMeetingMinutes: async (input) => {
          writes.push(input);
          return { written: true, owner: 'test', repo: 'meeting-plugin' };
        },
      },
    };
    const first = createMeetingMinutesManager({
      ...commonDependencies,
      scheduleFn: (callback, delay) => firstScheduler.schedule(callback, delay),
      clearScheduleFn: (job) => firstScheduler.clear(job),
    });
    await first.rememberMeeting(meeting());
    await first.handleMeetingEnded({ meetingId: 'meeting-1', roomId: 'room-1' });

    if (restartPoint === 'after-one-failed-retry') {
      const failedAttempt = firstScheduler.next();
      clock.now += failedAttempt.delay;
      await failedAttempt.run();
      assert.equal((await first.readJob('meeting-1')).attempts, 1);
    }
    first.dispose(); // simulates process shutdown with its persisted job left on disk

    transcriptAvailable = true;
    const secondScheduler = createFakeScheduler();
    const second = createMeetingMinutesManager({
      ...commonDependencies,
      scheduleFn: (callback, delay) => secondScheduler.schedule(callback, delay),
      clearScheduleFn: (job) => secondScheduler.clear(job),
    });
    assert.equal(await second.resumePending(), 1, `${restartPoint}: the persisted job is discovered`);
    const resumedAttempt = secondScheduler.next();
    assert.ok(resumedAttempt, `${restartPoint}: the recovered job is scheduled`);
    clock.now += resumedAttempt.delay;
    await resumedAttempt.run();

    assert.equal(writes.length, 1, `${restartPoint}: restart produces one hand-off`);
    assert.equal((await second.readJob('meeting-1')).status, 'processed');
    second.dispose();
  }
}

async function f5ReactiveRefreshHandlesSuccessFailureAndConcurrent401s() {
  const originalFetch = global.fetch;
  try {
    let refreshCalls = 0;
    let protectedCalls = 0;
    global.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/access_token')) {
        refreshCalls += 1;
        return jsonResponse({ access_token: 'fresh-token' });
      }
      if (String(url).endsWith('/meetings/one-401')) {
        protectedCalls += 1;
        return options.headers.Authorization === 'Bearer stale-token'
          ? jsonResponse({}, 401)
          : jsonResponse({ id: 'one-401' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const single = createTokenStore({
      meetingAccessToken: 'stale-token',
      meetingRefreshToken: 'refresh-token',
      meetingClientId: 'client-id',
      meetingClientSecret: 'client-secret',
      canRefreshMeetingToken: true,
    });
    assert.deepEqual(await single.meetingFetch('/meetings/one-401'), { id: 'one-401' });
    assert.equal(refreshCalls, 1);
    assert.equal(protectedCalls, 2, 'one 401 is followed by one retry');
    assert.equal(single.getToken(), 'fresh-token');

    refreshCalls = 0;
    protectedCalls = 0;
    global.fetch = async (url) => {
      if (String(url).endsWith('/access_token')) {
        refreshCalls += 1;
        return jsonResponse('refresh rejected', 400);
      }
      if (String(url).endsWith('/meetings/refresh-fails')) {
        protectedCalls += 1;
        return jsonResponse({}, 401);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const refreshFailure = createTokenStore({
      meetingAccessToken: 'stale-token',
      meetingRefreshToken: 'refresh-token',
      meetingClientId: 'client-id',
      meetingClientSecret: 'client-secret',
      canRefreshMeetingToken: true,
    });
    await assert.rejects(refreshFailure.meetingFetch('/meetings/refresh-fails'), /token refresh → 400/);
    assert.equal(refreshCalls, 1);
    assert.equal(protectedCalls, 1, 'a failed refresh does not retry indefinitely');

    refreshCalls = 0;
    protectedCalls = 0;
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    global.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/access_token')) {
        refreshCalls += 1;
        await refreshGate;
        return jsonResponse({ access_token: 'fresh-token' });
      }
      if (String(url).includes('/meetings/concurrent-401')) {
        protectedCalls += 1;
        return options.headers.Authorization === 'Bearer stale-token'
          ? jsonResponse({}, 401)
          : jsonResponse({ id: 'concurrent-401' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const concurrent = createTokenStore({
      meetingAccessToken: 'stale-token',
      meetingRefreshToken: 'refresh-token',
      meetingClientId: 'client-id',
      meetingClientSecret: 'client-secret',
      canRefreshMeetingToken: true,
    });
    const requests = Array.from({ length: 3 }, () => concurrent.meetingFetch('/meetings/concurrent-401'));
    // Let all requests receive their 401 before the single shared refresh is released.
    await waitFor(() => protectedCalls === 3 && refreshCalls === 1, 'three 401s and their shared refresh');
    assert.equal(protectedCalls, 3, 'all concurrent requests received the injected 401');
    assert.equal(refreshCalls, 1, 'concurrent 401s share one refresh request');
    releaseRefresh();
    assert.deepEqual(await Promise.all(requests), [
      { id: 'concurrent-401' },
      { id: 'concurrent-401' },
      { id: 'concurrent-401' },
    ]);
    assert.equal(protectedCalls, 6, 'each request retries once with the fresh token');
  } finally {
    global.fetch = originalFetch;
  }
}

test('F1: missed start webhook recovery across instant/scheduled meetings and poll-cycle variants', { concurrency: false }, f1MissedStartWebhookRecoversAcrossMeetingKindsAndPollCycles);
test('F2: delayed transcript recovery and deadline exhaustion', { concurrency: false }, f2TranscriptRecoveryHandlesDelayAndDeadlineExhaustion);
test('F3: concurrent duplicate start and transcript event idempotency', { concurrency: false }, f3ConcurrentDuplicateEventsProduceSingleEffects);
test('F4: restart recovery before first retry and after a failed retry', { concurrency: false }, f4RestartResumesRecoveryBeforeAndAfterFailedAttempt);
test('F5: one 401 recovery, failed refresh, and concurrent 401 coalescing', { concurrency: false }, f5ReactiveRefreshHandlesSuccessFailureAndConcurrent401s);
