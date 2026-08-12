// Post-meeting minutes pipeline.
//
// Primary path: meetingTranscripts/created -> download -> summarize -> persist.
// Recovery path: meetings/ended -> durable bounded polling until Webex exposes
// the transcript. Pending jobs survive gateway restarts in the OpenClaw
// workspace; generated minutes are committed to the space's primary repo.
'use strict';

const { createHash } = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createMinutesStore } = require('./minutes-store');
const { createMinutesSummarizer } = require('./minutes-summarizer');

const DEFAULT_WORKSPACE_ROOT = '/home/node/.openclaw/workspace';
const JOB_DIR = path.join('.collab', 'webex-meeting-minutes', 'jobs');

function getWorkspaceRoot(explicitRoot) {
  return explicitRoot ?? process.env.OPENCLAW_WORKSPACE_DIR ?? DEFAULT_WORKSPACE_ROOT;
}

function meetingKey(meetingId) {
  return createHash('sha256').update(String(meetingId)).digest('hex');
}

function jobPath(meetingId, workspaceRoot) {
  return path.join(getWorkspaceRoot(workspaceRoot), JOB_DIR, `${meetingKey(meetingId)}.json`);
}

function meetingSnapshot(meeting = {}, fallbackRoomId = null) {
  const values = {
    roomId: meeting.roomId ?? fallbackRoomId ?? null,
    title: meeting.title ?? meeting.topic ?? null,
    start: meeting.start ?? meeting.startTime ?? meeting.actualStart ?? null,
    end: meeting.end ?? meeting.endTime ?? meeting.actualEnd ?? null,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value != null && value !== ''));
}

function compactError(err) {
  return String(err?.message ?? err ?? 'unknown error').slice(0, 1000);
}

function createMeetingMinutesManager({
  runtime,
  tokenStore,
  config = {},
  workspaceRoot = null,
  minutesStore = null,
  summarizer = null,
  log = null,
  now = () => Date.now(),
  scheduleFn = setTimeout,
  clearScheduleFn = clearTimeout,
} = {}) {
  const recoveryDelayMs = config.recoveryDelayMs ?? 60_000;
  const recoveryMaxDelayMs = config.recoveryMaxDelayMs ?? 5 * 60 * 1000;
  const recoveryWindowMs = config.recoveryWindowMs ?? 2 * 60 * 60 * 1000;
  const store = minutesStore ?? createMinutesStore({ workspaceRoot, log });
  const minutesSummarizer = summarizer ?? createMinutesSummarizer({
    runtime,
    chunkChars: config.chunkChars ?? null,
    log,
  });
  const timers = new Map(); // meetingId -> timeout
  const locks = new Map(); // meetingId -> serial promise chain

  async function readJob(meetingId) {
    try {
      return JSON.parse(await fsp.readFile(jobPath(meetingId, workspaceRoot), 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeJob(job) {
    const file = jobPath(job.meetingId, workspaceRoot);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    await fsp.rename(temp, file);
    return job;
  }

  function withMeetingLock(meetingId, fn) {
    const previous = locks.get(meetingId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn).finally(() => {
      if (locks.get(meetingId) === next) locks.delete(meetingId);
    });
    locks.set(meetingId, next);
    return next;
  }

  function clearRecovery(meetingId) {
    const timer = timers.get(meetingId);
    if (timer != null) clearScheduleFn(timer);
    timers.delete(meetingId);
  }

  function nextDelay(attempts) {
    return Math.min(recoveryDelayMs * 2 ** Math.max(0, attempts - 1), recoveryMaxDelayMs);
  }

  function scheduleRecovery(meetingId, delayMs) {
    clearRecovery(meetingId);
    let handle;
    const callback = async () => {
      if (timers.get(meetingId) === handle) timers.delete(meetingId);
      try {
        await withMeetingLock(meetingId, () => attemptRecoveryLocked(meetingId));
      } catch (err) {
        log?.error?.(`[webex-meeting-join] transcript recovery failed meeting=${meetingId}: ${compactError(err)}`);
      }
    };
    handle = scheduleFn(callback, Math.max(0, delayMs));
    handle?.unref?.();
    timers.set(meetingId, handle);
  }

  async function fetchMeetingDetails(meetingId) {
    try {
      return await tokenStore.meetingFetch(`/meetings/${encodeURIComponent(meetingId)}`);
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] could not resolve ended meeting=${meetingId}: ${compactError(err)}`);
      return null;
    }
  }

  async function findTranscript(meetingId, preferredTranscriptId = null) {
    const query = new URLSearchParams({ meetingId: String(meetingId) });
    const result = await tokenStore.meetingFetch(`/meetingTranscripts?${query}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    if (preferredTranscriptId) {
      const preferred = items.find((item) => item?.id === preferredTranscriptId);
      if (preferred) return preferred;
    }
    return items[0] ?? null;
  }

  async function downloadTranscript({ meetingId, transcript }) {
    const transcriptId = transcript?.id;
    if (!transcriptId) throw new Error(`Transcript for meeting ${meetingId} has no id`);
    const encodedId = encodeURIComponent(transcriptId);
    const encodedMeetingId = encodeURIComponent(meetingId);
    const candidates = [
      transcript.vttDownloadLink,
      transcript.txtDownloadLink,
      `/meetingTranscripts/${encodedId}/download?meetingId=${encodedMeetingId}&format=vtt`,
      `/meetingTranscripts/${encodedId}/download?meetingId=${encodedMeetingId}&format=txt`,
    ].filter((value, index, values) => value && values.indexOf(value) === index);
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const text = String(await tokenStore.meetingFetchText(candidate)).trim();
        if (text) return text;
        lastError = new Error(`Transcript download returned empty content from ${candidate}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error(`No download link available for transcript ${transcriptId}`);
  }

  async function processTranscriptLocked(job, suppliedTranscript = null) {
    if (job.status === 'processed') return { processed: false, duplicate: true };
    const transcript = suppliedTranscript ?? await findTranscript(job.meetingId, job.transcriptId);
    if (!transcript) return { processed: false, available: false };

    let meeting = job.meeting ?? {};
    if (!meeting.roomId || !meeting.title || !meeting.start || !meeting.end) {
      const fetched = await fetchMeetingDetails(job.meetingId);
      if (fetched) meeting = { ...meeting, ...meetingSnapshot(fetched, meeting.roomId) };
    }
    if (!meeting.roomId) {
      throw new Error(`Cannot map Webex meeting ${job.meetingId} to a project room`);
    }

    const transcriptText = await downloadTranscript({ meetingId: job.meetingId, transcript });
    const minutes = await minutesSummarizer.summarize({
      roomId: meeting.roomId,
      meetingId: job.meetingId,
      meeting,
      transcript: transcriptText,
    });
    const result = await store.appendMeetingMinutes({
      roomId: meeting.roomId,
      meetingId: job.meetingId,
      transcriptId: transcript.id,
      meeting,
      minutes,
    });
    const processed = {
      ...job,
      meeting,
      transcriptId: transcript.id,
      status: 'processed',
      processedAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      lastError: null,
    };
    await writeJob(processed);
    clearRecovery(job.meetingId);
    log?.info?.(
      `[webex-meeting-join] stored meeting minutes meeting=${job.meetingId} ` +
        `repo=${result.owner ?? 'unknown'}/${result.repo ?? 'unknown'}`
    );
    return { processed: true, ...result };
  }

  async function rescheduleAfterFailure(job, err = null) {
    const attempts = Number(job.attempts ?? 0) + 1;
    const delay = nextDelay(attempts);
    const updated = {
      ...job,
      status: 'pending',
      attempts,
      nextAttemptAt: new Date(now() + delay).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      ...(err ? { lastError: compactError(err) } : {}),
    };
    await writeJob(updated);
    scheduleRecovery(job.meetingId, delay);
    return updated;
  }

  async function attemptRecoveryLocked(meetingId) {
    const job = await readJob(meetingId);
    if (!job || job.status === 'processed' || job.status === 'exhausted') return;
    if (job.deadlineAt && now() >= new Date(job.deadlineAt).getTime()) {
      await writeJob({
        ...job,
        status: 'exhausted',
        updatedAt: new Date(now()).toISOString(),
        lastError: job.lastError ?? 'Webex transcript did not become available before the recovery deadline',
      });
      log?.warn?.(`[webex-meeting-join] transcript recovery exhausted meeting=${meetingId}`);
      return;
    }
    try {
      const transcript = await findTranscript(meetingId, job.transcriptId);
      if (!transcript) {
        await rescheduleAfterFailure(job);
        return;
      }
      await processTranscriptLocked({ ...job, transcriptId: transcript.id }, transcript);
    } catch (err) {
      log?.warn?.(`[webex-meeting-join] transcript recovery attempt failed meeting=${meetingId}: ${compactError(err)}`);
      await rescheduleAfterFailure(job, err);
    }
  }

  async function rememberMeeting(meeting) {
    const meetingId = meeting?.id;
    if (!meetingId) return null;
    return withMeetingLock(meetingId, async () => {
      const existing = await readJob(meetingId);
      const timestamp = new Date(now()).toISOString();
      const job = {
        ...(existing ?? {}),
        meetingId,
        status: existing?.status ?? 'observed',
        attempts: existing?.attempts ?? 0,
        meeting: { ...(existing?.meeting ?? {}), ...meetingSnapshot(meeting, existing?.meeting?.roomId) },
        observedAt: existing?.observedAt ?? timestamp,
        updatedAt: timestamp,
      };
      return writeJob(job);
    });
  }

  async function handleMeetingEnded({ meetingId, roomId = null } = {}) {
    if (!meetingId) return null;
    return withMeetingLock(meetingId, async () => {
      const existing = await readJob(meetingId);
      if (existing?.status === 'processed') return { processed: true };
      let meeting = { ...(existing?.meeting ?? {}) };
      if (roomId && !meeting.roomId) meeting.roomId = roomId;
      if (!meeting.roomId || !meeting.title || !meeting.start || !meeting.end) {
        const fetched = await fetchMeetingDetails(meetingId);
        if (fetched) meeting = { ...meeting, ...meetingSnapshot(fetched, meeting.roomId) };
      }
      const timestamp = new Date(now()).toISOString();
      const deadlineAt = existing?.deadlineAt ?? new Date(now() + recoveryWindowMs).toISOString();
      const job = {
        ...(existing ?? {}),
        meetingId,
        status: 'pending',
        attempts: existing?.attempts ?? 0,
        meeting,
        endedAt: existing?.endedAt ?? timestamp,
        deadlineAt,
        nextAttemptAt: new Date(now() + recoveryDelayMs).toISOString(),
        updatedAt: timestamp,
      };
      await writeJob(job);
      scheduleRecovery(meetingId, recoveryDelayMs);
      log?.info?.(`[webex-meeting-join] scheduled transcript recovery meeting=${meetingId}`);
      return { scheduled: true };
    });
  }

  async function handleTranscriptCreated(payload) {
    const transcriptId = payload?.data?.id;
    const meetingId = payload?.data?.meetingId;
    if (!transcriptId || !meetingId) {
      log?.warn?.('[webex-meeting-join] meetingTranscripts/created webhook missing data.id or data.meetingId');
      return { skipped: 'missing-id' };
    }
    clearRecovery(meetingId);
    return withMeetingLock(meetingId, async () => {
      const existing = await readJob(meetingId);
      if (existing?.status === 'processed') return { processed: false, duplicate: true };
      const timestamp = new Date(now()).toISOString();
      const job = {
        ...(existing ?? {}),
        meetingId,
        status: 'pending',
        attempts: existing?.attempts ?? 0,
        transcriptId,
        deadlineAt: existing?.deadlineAt ?? new Date(now() + recoveryWindowMs).toISOString(),
        transcriptWebhookAt: timestamp,
        updatedAt: timestamp,
      };
      await writeJob(job);
      try {
        return await processTranscriptLocked(job, { id: transcriptId, meetingId });
      } catch (err) {
        log?.warn?.(`[webex-meeting-join] transcript webhook processing failed meeting=${meetingId}: ${compactError(err)}`);
        await rescheduleAfterFailure(job, err);
        return { processed: false, recoveryScheduled: true, error: compactError(err) };
      }
    });
  }

  async function resumePending() {
    const dir = path.join(getWorkspaceRoot(workspaceRoot), JOB_DIR);
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') return 0;
      throw err;
    }
    let resumed = 0;
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      try {
        const job = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8'));
        if (!job?.meetingId || job.status !== 'pending') continue;
        const nextAt = job.nextAttemptAt ? new Date(job.nextAttemptAt).getTime() : now();
        scheduleRecovery(job.meetingId, Math.max(0, nextAt - now()));
        resumed += 1;
      } catch (err) {
        log?.warn?.(`[webex-meeting-join] skipped invalid meeting-minutes job ${file}: ${compactError(err)}`);
      }
    }
    if (resumed) log?.info?.(`[webex-meeting-join] resumed ${resumed} transcript recovery job(s)`);
    return resumed;
  }

  function dispose() {
    for (const meetingId of timers.keys()) clearRecovery(meetingId);
  }

  return {
    rememberMeeting,
    handleMeetingEnded,
    handleTranscriptCreated,
    resumePending,
    dispose,
    // Narrow test/debug seams; no caller should invoke these in normal flow.
    readJob,
    jobPath: (meetingId) => jobPath(meetingId, workspaceRoot),
  };
}

module.exports = { createMeetingMinutesManager, jobPath, meetingSnapshot };
