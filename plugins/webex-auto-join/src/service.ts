import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDiscoveredInvitation, isJoinableMeeting, isTerminalMeeting } from './discovery';
import { WebexMessageDelivery } from './notifications';
import {
  delay,
  ensureOwnedWebhooks,
  readRawBody,
  verifyWebhookSignature,
  WEBEX_API,
  WebexApiError,
  webexList,
  webexRequest,
} from './webex';

const ACTIVE_STATES = new Set([
  'preparing',
  'ready_for_browser',
  'joining',
  'waiting_for_admission',
  'joined',
  'leaving',
  'interrupted',
  'recovering',
]);

type Invitation = {
  destination: string;
  joinLink?: string;
  password?: string;
  meetingId?: string;
  meetingNumber?: string;
  discoveredAt: string;
};

type Session = {
  id: string;
  roomId: string;
  parentId?: string;
  source: 'manual' | 'automatic';
  invitation: Invitation;
  state: string;
  tabId?: string;
  tabLabel?: string;
  inspectedTargetId?: string;
  inspectedRefs?: string[];
  recoveryAttempts: number;
  errorCode?: string;
  leaveRequested?: boolean;
  createdAt: string;
  updatedAt: string;
};

type ManagedRoom = {
  roomId: string;
  title?: string;
  covered: boolean;
  membershipId?: string;
  membershipProvenance?: 'existing' | 'created';
  lastError?: string;
  updatedAt: string;
};

type ScheduledMeeting = {
  id: string;
  seriesId?: string;
  roomId: string;
  title?: string;
  start: string;
  end?: string;
  destination: string;
  webLink?: string;
  sipAddress?: string;
  password?: string;
  fallbackUntil: string;
  updatedAt: string;
};

type PendingMeeting = {
  meetingId: string;
  roomId: string;
  destination: string;
  webLink?: string;
  password?: string;
  meetingNumber?: string;
  expiresAt: string;
  updatedAt: string;
};

type OAuthState = { accessToken: string; refreshToken: string; expiresAt: number };

type PersistedState = {
  version: 2;
  sessions: Record<string, Session>;
  rooms: Record<string, ManagedRoom>;
  schedules: Record<string, ScheduledMeeting>;
  pending: Record<string, PendingMeeting>;
  notifications: Record<string, string>;
  token?: OAuthState;
};

type BrowserControlErrorDetails = {
  status?: number;
  controlCode?: string;
  controlError?: string;
};

type AssetPaths = { runner?: string; sdk?: string };

function emptyState(): PersistedState {
  return { version: 2, sessions: {}, rooms: {}, schedules: {}, pending: {}, notifications: {} };
}

function nowIso() {
  return new Date().toISOString();
}

function configured(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized && !normalized.startsWith('${') ? normalized : '';
}

function safeErrorCode(error: unknown) {
  const controlCode = String((error as any)?.controlCode ?? '');
  if (controlCode === 'ACT_TARGET_ID_MISMATCH') return 'browser_target_id_mismatch';
  if (controlCode === 'ACT_INVALID_REQUEST' || controlCode === 'ACT_KIND_REQUIRED') return 'browser_action_invalid';
  if (controlCode === 'ACT_EXISTING_SESSION_UNSUPPORTED') return 'browser_action_unsupported';
  const explicitCode = String((error as any)?.code ?? '');
  if (explicitCode === 'browser_control_unavailable' || explicitCode === 'browser_control_unauthorized') return explicitCode;
  if (explicitCode === 'webhook_body_too_large') return explicitCode;
  const status = Number((error as any)?.status ?? 0);
  if (status === 401 || status === 403) return 'webex_authorization_failed';
  const message = String((error as any)?.message ?? error ?? '').toLowerCase();
  if (message.includes('captcha')) return 'captcha_required';
  if (message.includes('password')) return 'meeting_password_rejected';
  if (message.includes('token') || message.includes('oauth')) return 'oauth_unavailable';
  if (message.includes('capacity')) return 'capacity_reached';
  if (message.includes('history')) return 'meeting_history_unavailable';
  return 'meeting_join_failed';
}

function safePublicFailureCode(code: unknown) {
  const normalized = String(code ?? '').trim().toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(normalized) ? normalized : 'meeting_join_failed';
}

function browserActionFailure(error: unknown) {
  const controlCode = String((error as any)?.controlCode ?? '');
  const message = String((error as any)?.controlError ?? (error as any)?.message ?? error ?? '').toLowerCase();
  if (controlCode === 'ACT_TARGET_ID_MISMATCH') return { error_code: 'browser_target_id_mismatch', retryable: false };
  if (controlCode === 'ACT_INVALID_REQUEST' || controlCode === 'ACT_KIND_REQUIRED') return { error_code: 'browser_action_invalid', retryable: false };
  if (controlCode === 'ACT_EXISTING_SESSION_UNSUPPORTED') return { error_code: 'browser_action_unsupported', retryable: false };
  if (message.includes('unknown ref') || message.includes('stale') || message.includes('tab not found')) {
    return { error_code: 'meeting_runner_snapshot_stale', retryable: true };
  }
  const code = safeErrorCode(error);
  return { error_code: code === 'browser_control_unauthorized' ? code : 'meeting_runner_action_failed', retryable: code !== 'browser_control_unauthorized' };
}

function snapshotRefs(snapshot: any) {
  const refs = new Set<string>();
  if (snapshot?.refs && typeof snapshot.refs === 'object') {
    for (const ref of Object.keys(snapshot.refs)) if (/^(?:\d+|e\d+|ax\d+)$/.test(ref)) refs.add(ref);
  }
  const text = String(snapshot?.snapshot ?? snapshot?.nodes ?? '');
  for (const match of text.matchAll(/(?:\[ref=|aria-ref=["'])(\d+|e\d+|ax\d+)(?:\]|["'])/g)) refs.add(match[1]);
  return [...refs];
}

function isLoopback(address?: string) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function parseCookies(raw?: string) {
  return Object.fromEntries(String(raw ?? '').split(';').map((part) => part.trim().split('=')).filter(([key, value]) => key && value));
}

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: any, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function createInvitation(joinLink: unknown, password: unknown): Invitation | null {
  let parsed: URL;
  try { parsed = new URL(String(joinLink ?? '').trim()); }
  catch { return null; }
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'webex.com' || parsed.hostname.endsWith('.webex.com'))) return null;
  const normalizedPassword = String(password ?? '').trim();
  if (!normalizedPassword) return null;
  return { destination: parsed.toString(), joinLink: parsed.toString(), password: normalizedPassword, discoveredAt: nowIso() };
}

async function fileExists(filename: string) {
  try { await access(filename); return true; }
  catch { return false; }
}

class EncryptedState {
  private readonly key: Buffer;
  readonly statePath: string;

  constructor(rawKey: string | undefined, statePath: string) {
    const key = rawKey ? Buffer.from(rawKey, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) throw new Error('encryption key must be a base64-encoded 32-byte key');
    this.key = key;
    this.statePath = statePath;
  }

  async load(): Promise<PersistedState> {
    try {
      const envelope = JSON.parse(await readFile(this.statePath, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      const parsed = JSON.parse(plain.toString('utf8'));
      return {
        version: 2,
        sessions: parsed.sessions ?? {},
        rooms: parsed.rooms ?? {},
        schedules: parsed.schedules ?? {},
        pending: parsed.pending ?? {},
        notifications: parsed.notifications ?? {},
        token: parsed.token,
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return emptyState();
      throw new Error('auto-join state could not be decrypted; refusing to use stored credentials');
    }
  }

  async save(state: PersistedState) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({
      v: 2,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, envelope, { mode: 0o600 });
    await rename(temp, this.statePath);
  }
}

class BrowserControlError extends Error {
  code: string;
  status?: number;
  controlCode?: string;
  controlError?: string;

  constructor(message: string, code: string, details: BrowserControlErrorDetails = {}) {
    super(message);
    this.name = 'BrowserControlError';
    this.code = code;
    Object.assign(this, details);
  }
}

class BrowserControl {
  constructor(private readonly profile: string) {}

  private get baseUrl() {
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? 18789) + 2;
    return `http://127.0.0.1:${port}`;
  }

  private async request(method: string, pathname: string, body?: unknown) {
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (!token) throw new BrowserControlError('OPENCLAW_GATEWAY_TOKEN is required for browser control', 'browser_control_unauthorized');
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}${pathname.includes('?') ? '&' : '?'}profile=${encodeURIComponent(this.profile)}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new BrowserControlError('OpenClaw browser control is unreachable', 'browser_control_unavailable', { controlError: String((cause as any)?.message ?? cause ?? '') });
    }
    if (!response.ok) {
      const responseBody: any = await response.json().catch(() => ({}));
      throw new BrowserControlError(`Browser control ${method} ${pathname} failed (${response.status})`, response.status === 401 || response.status === 403 ? 'browser_control_unauthorized' : 'browser_control_unavailable', {
        status: response.status,
        controlCode: typeof responseBody?.code === 'string' ? responseBody.code : undefined,
        controlError: typeof responseBody?.error === 'string' ? responseBody.error : undefined,
      });
    }
    return response.json().catch(() => ({}));
  }

  start() { return this.request('POST', '/start?headless=true'); }
  async open(url: string, label: string) {
    const result: any = await this.request('POST', '/tabs/open', { url, label });
    return result.suggestedTargetId ?? result.targetId ?? result.id;
  }
  async close(tabId?: string) { if (tabId) await this.request('DELETE', `/tabs/${encodeURIComponent(tabId)}`).catch(() => undefined); }
  snapshot(tabId: string) { return this.request('GET', `/snapshot?targetId=${encodeURIComponent(tabId)}&format=ai`); }
  click(targetId: string, ref: string) { return this.request('POST', '/act', { kind: 'click', targetId, ref }); }
}

export class MeetingJoinService {
  private state: PersistedState = emptyState();
  private store: EncryptedState | null = null;
  private runnerNonces = new Map<string, { sessionId: string; expiresAt: number }>();
  private runnerCookies = new Map<string, { sessionId: string; expiresAt: number }>();
  private queues = new Map<string, Promise<void>>();
  private scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private enabled = false;
  private stopped = false;
  private startTask: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private membershipTimer: ReturnType<typeof setInterval> | null = null;
  private meetingTimer: ReturnType<typeof setInterval> | null = null;
  private botId = '';
  private attendeeId = '';
  private cfg: any;
  private browser: BrowserControl;
  private messages: WebexMessageDelivery;

  constructor(private readonly runtime: any, config: any, private readonly log: any = console, private readonly assets: AssetPaths = {}) {
    this.cfg = {
      botToken: configured(config?.botToken) || configured(process.env.WEBEX_BOT_TOKEN),
      webhookUrl: configured(config?.webhookUrl) || configured(process.env.WEBEX_AUTO_JOIN_WEBHOOK_URL),
      webhookSecret: configured(config?.webhookSecret) || configured(process.env.WEBEX_WEBHOOK_SECRET),
      attendeeClientId: configured(config?.attendeeClientId) || configured(process.env.MEETING_JOIN_CLIENT_ID),
      attendeeClientSecret: configured(config?.attendeeClientSecret) || configured(process.env.MEETING_JOIN_CLIENT_SECRET),
      attendeeRefreshToken: configured(config?.attendeeRefreshToken) || configured(process.env.MEETING_JOIN_REFRESH_TOKEN),
      expectedAttendeeEmail: (configured(config?.expectedAttendeeEmail) || configured(process.env.MEETING_JOIN_EXPECTED_EMAIL)).toLowerCase(),
      encryptionKey: configured(config?.encryptionKey) || configured(process.env.MEETING_JOIN_ENCRYPTION_KEY),
      maxConcurrentMeetings: config?.maxConcurrentMeetings ?? 4,
      browserProfile: config?.browserProfile ?? 'webex-auto-join',
      requireBrowserReview: config?.requireBrowserReview ?? false,
      recoveryMaxAttempts: config?.recoveryMaxAttempts ?? 5,
      recoveryBaseDelayMs: config?.recoveryBaseDelayMs ?? 1000,
      meetingReconcileIntervalMs: (config?.meetingReconcileIntervalSeconds ?? 60) * 1000,
      membershipReconcileIntervalMs: (config?.membershipReconcileIntervalSeconds ?? 300) * 1000,
      schedulingHorizonDays: config?.schedulingHorizonDays ?? 30,
      scheduledStartGraceMinutes: config?.scheduledStartGraceMinutes ?? 30,
      notificationMode: config?.notificationMode ?? 'join-and-failure',
    };
    this.browser = new BrowserControl(this.cfg.browserProfile);
    this.messages = new WebexMessageDelivery(this.cfg.botToken);
  }

  async start() {
    if (this.startTask) return this.startTask;
    this.startTask = this.startInternal();
    return this.startTask;
  }

  private async startInternal() {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), '.openclaw');
    const statePath = path.join(stateDir, 'webex-auto-join-state.enc');
    try {
      this.requireAutomationConfig();
      this.store = new EncryptedState(this.cfg.encryptionKey, statePath);
      const newStateExists = await fileExists(statePath);
      this.state = await this.store.load();
      if (!newStateExists) await this.importLegacyToken(path.join(stateDir, 'meeting-join-state.enc'));
      const attendeeToken = await this.getAccessToken();
      const [bot, attendee] = await Promise.all([
        webexRequest(this.cfg.botToken, '/people/me').then((result) => result.data),
        webexRequest(attendeeToken, '/people/me').then((result) => result.data),
      ]);
      this.botId = configured(bot?.id);
      this.attendeeId = configured(attendee?.id);
      const attendeeEmails = [attendee?.email, ...(Array.isArray(attendee?.emails) ? attendee.emails : [])]
        .map((email) => String(email ?? '').toLowerCase())
        .filter(Boolean);
      if (!this.botId || !this.attendeeId || this.botId === this.attendeeId) throw new Error('Webex bot and attendee identities must be distinct');
      if (!attendeeEmails.includes(this.cfg.expectedAttendeeEmail)) throw new Error('configured attendee identity does not match OAuth token');
      await this.ensureWebhooks(attendeeToken);
      this.enabled = true;
      await this.reconcileMemberships();
      await this.reconcileMeetings();
      this.rebuildScheduleTimers();
      await this.recoverActiveSessions();
      this.heartbeatTimer = setInterval(() => this.checkHeartbeats().catch(() => undefined), 15_000);
      this.membershipTimer = setInterval(() => this.reconcileMemberships().catch((error) => this.logFailure('membership reconciliation', error)), this.cfg.membershipReconcileIntervalMs);
      this.meetingTimer = setInterval(() => this.reconcileMeetings().catch((error) => this.logFailure('meeting reconciliation', error)), this.cfg.meetingReconcileIntervalMs);
      this.heartbeatTimer.unref?.();
      this.membershipTimer.unref?.();
      this.meetingTimer.unref?.();
      this.log?.info?.(`[webex-auto-join] ready: ${Object.values(this.state.rooms).filter((room) => room.covered).length} covered spaces`);
    } catch (error) {
      this.enabled = false;
      this.logFailure('startup disabled', error);
    }
  }

  async stop() {
    this.stopped = true;
    for (const timer of [this.heartbeatTimer, this.membershipTimer, this.meetingTimer]) if (timer) clearInterval(timer);
    for (const timer of this.scheduleTimers.values()) clearTimeout(timer);
    this.scheduleTimers.clear();
    for (const session of Object.values(this.state.sessions)) {
      if (!ACTIVE_STATES.has(session.state)) continue;
      await this.browser.close(session.tabId);
      session.tabId = undefined;
      session.state = session.state === 'leaving' ? 'left' : 'interrupted';
      session.updatedAt = nowIso();
    }
    this.runnerNonces.clear();
    this.runnerCookies.clear();
    await this.persist().catch(() => undefined);
  }

  private requireAutomationConfig() {
    for (const key of ['botToken', 'webhookUrl', 'webhookSecret', 'attendeeClientId', 'attendeeClientSecret', 'attendeeRefreshToken', 'expectedAttendeeEmail', 'encryptionKey']) {
      if (!this.cfg[key]) throw new Error(`webex-auto-join config is missing ${key}`);
    }
    const url = new URL(this.cfg.webhookUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/webhooks/webex-auto-join' || url.search || url.hash || url.username || url.password) {
      throw new Error('webhookUrl must be an HTTPS origin plus /webhooks/webex-auto-join');
    }
  }

  private async importLegacyToken(legacyPath: string) {
    if (!await fileExists(legacyPath)) return;
    const legacy = await new EncryptedState(this.cfg.encryptionKey, legacyPath).load();
    if (legacy.token) {
      this.state.token = legacy.token;
      await this.persist();
      this.log?.info?.('[webex-auto-join] imported rotating OAuth token from legacy meeting-join state');
    }
  }

  private async ensureWebhooks(attendeeToken: string) {
    await ensureOwnedWebhooks(this.cfg.botToken, this.cfg.webhookUrl, this.cfg.webhookSecret, [
      { name: 'OpenClaw Webex Auto Join Membership Created', resource: 'memberships', event: 'created' },
      { name: 'OpenClaw Webex Auto Join Membership Deleted', resource: 'memberships', event: 'deleted' },
    ]);
    await ensureOwnedWebhooks(attendeeToken, this.cfg.webhookUrl, this.cfg.webhookSecret, [
      { name: 'OpenClaw Webex Auto Join Meeting Created', resource: 'meetings', event: 'created' },
      { name: 'OpenClaw Webex Auto Join Meeting Updated', resource: 'meetings', event: 'updated' },
      { name: 'OpenClaw Webex Auto Join Meeting Deleted', resource: 'meetings', event: 'deleted' },
    ]);
  }

  async handleWebhookRoute(req: any, res: any) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end('Method Not Allowed');
      return true;
    }
    let raw: Buffer;
    try { raw = await readRawBody(req); }
    catch (error) { res.statusCode = safeErrorCode(error) === 'webhook_body_too_large' ? 413 : 400; res.end(); return true; }
    if (!verifyWebhookSignature(this.cfg.webhookSecret, raw, req.headers?.['x-spark-signature'])) {
      res.statusCode = 401;
      res.end('Unauthorized');
      return true;
    }
    let payload: any;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { res.statusCode = 400; res.end('Bad Request'); return true; }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
    const key = `${payload?.resource ?? 'unknown'}:${payload?.data?.roomId ?? payload?.data?.id ?? 'unknown'}`;
    this.enqueue(key, () => this.dispatchWebhook(payload));
    return true;
  }

  private enqueue(key: string, task: () => Promise<void>) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task).catch((error) => this.logFailure(`webhook ${key}`, error)).finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
    this.queues.set(key, current);
  }

  private async dispatchWebhook(payload: any) {
    if (!this.enabled) return;
    if (payload?.resource === 'memberships') return this.handleMembershipWebhook(payload);
    if (payload?.resource !== 'meetings') return;
    const meetingId = configured(payload?.data?.id);
    if (payload?.event === 'deleted') {
      await this.removeMeeting(meetingId, configured(payload?.data?.roomId));
      return;
    }
    if (payload?.data?.meetingType || payload?.data?.state) await this.processMeeting(payload.data);
    if (meetingId) {
      const meeting = await this.fetchMeetingWithRetry(meetingId);
      if (meeting) await this.processMeeting(meeting);
    }
  }

  private async handleMembershipWebhook(payload: any) {
    const personId = configured(payload?.data?.personId);
    const roomId = configured(payload?.data?.roomId);
    if (!roomId) return;
    if (personId === this.botId) {
      if (payload.event === 'deleted') await this.removeManagedRoom(roomId);
      else await this.ensureRoomCovered(roomId);
    } else if (personId === this.attendeeId && payload.event === 'deleted' && this.state.rooms[roomId]) {
      await this.ensureRoomCovered(roomId);
    }
  }

  async reconcileMemberships() {
    if (!this.enabled) return;
    const rooms = await webexList(this.cfg.botToken, '/rooms?type=group&max=1000');
    const seen = new Set<string>();
    for (const room of rooms) {
      const roomId = configured(room?.id);
      if (!roomId || room?.type === 'direct') continue;
      seen.add(roomId);
      await this.ensureRoomCovered(roomId, room);
    }
    for (const roomId of Object.keys(this.state.rooms)) if (!seen.has(roomId)) await this.removeManagedRoom(roomId);
  }

  private async ensureRoomCovered(roomId: string, suppliedRoom?: any) {
    let room = suppliedRoom;
    if (!room) {
      try { room = (await webexRequest(this.cfg.botToken, `/rooms/${encodeURIComponent(roomId)}`)).data; }
      catch (error) { this.logFailure(`room lookup ${roomId}`, error); return; }
    }
    if (room?.type === 'direct') return;
    const existingState = this.state.rooms[roomId];
    try {
      const query = `/memberships?roomId=${encodeURIComponent(roomId)}&personEmail=${encodeURIComponent(this.cfg.expectedAttendeeEmail)}&max=100`;
      const memberships = await webexList(this.cfg.botToken, query);
      let membership = memberships[0];
      let provenance: 'existing' | 'created' = existingState?.membershipProvenance === 'created' ? 'created' : 'existing';
      if (!membership) {
        membership = (await webexRequest(this.cfg.botToken, '/memberships', {
          method: 'POST',
          body: { roomId, personEmail: this.cfg.expectedAttendeeEmail, isModerator: false },
        })).data;
        provenance = 'created';
      }
      this.state.rooms[roomId] = {
        roomId,
        title: configured(room?.title) || existingState?.title,
        covered: true,
        membershipId: configured(membership?.id),
        membershipProvenance: provenance,
        updatedAt: nowIso(),
      };
      await this.persist();
    } catch (error) {
      const errorCode = 'membership_mirror_failed';
      this.state.rooms[roomId] = {
        roomId,
        title: configured(room?.title) || existingState?.title,
        covered: false,
        membershipId: existingState?.membershipId,
        membershipProvenance: existingState?.membershipProvenance,
        lastError: errorCode,
        updatedAt: nowIso(),
      };
      await this.persist();
      await this.notifyOnce(`coverage:${roomId}:${errorCode}`, roomId, `Could not add the configured meeting attendee to this space (${errorCode}). A moderator must allow or add ${this.cfg.expectedAttendeeEmail}.`)
        .catch((notificationError) => this.logFailure(`coverage notification ${roomId}`, notificationError));
      this.logFailure(`membership mirror ${roomId}`, error);
    }
  }

  private async removeManagedRoom(roomId: string) {
    const room = this.state.rooms[roomId];
    for (const schedule of Object.values(this.state.schedules)) if (schedule.roomId === roomId) this.deleteSchedule(schedule.id);
    for (const pending of Object.values(this.state.pending)) if (pending.roomId === roomId) delete this.state.pending[pending.meetingId];
    const active = Object.values(this.state.sessions).find((session) => session.roomId === roomId && ACTIVE_STATES.has(session.state));
    if (active) await this.leave(roomId);
    if (room?.membershipProvenance === 'created' && room.membershipId) {
      const token = await this.getAccessToken().catch(() => '');
      if (token) await webexRequest(token, `/memberships/${encodeURIComponent(room.membershipId)}`, { method: 'DELETE' }).catch((error) => this.logFailure(`attendee self-removal ${roomId}`, error));
    }
    delete this.state.rooms[roomId];
    await this.persist();
  }

  async reconcileMeetings() {
    if (!this.enabled) return;
    const token = await this.getAccessToken();
    const from = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const to = new Date(Date.now() + this.cfg.schedulingHorizonDays * 24 * 60 * 60_000).toISOString();
    const series = await webexList(token, `/meetings?meetingType=meetingSeries&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
    for (const meeting of series) await this.processMeeting(meeting);
    const scheduled = await webexList(token, `/meetings?meetingType=scheduledMeeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
    for (const meeting of scheduled) await this.processMeeting(meeting);
    const active = await this.listMeetingInstances(token, from, to);
    for (const meeting of active) await this.processMeeting(meeting);
    await this.drainPending();
    this.pruneSchedules();
    await this.persist();
  }

  private listMeetingInstances(token: string, from: string, to: string) {
    return webexList(token, `/meetings?meetingType=meeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
  }

  private async fetchMeetingWithRetry(meetingId: string) {
    const started = Date.now();
    const initialDelays = [0, 1000, 2000, 5000, 10_000, 20_000, 30_000];
    let attempt = 0;
    while (!this.stopped && Date.now() - started <= 10 * 60_000) {
      const wait = initialDelays[attempt] ?? 30_000;
      if (wait) await delay(wait);
      try { return (await webexRequest(await this.getAccessToken(), `/meetings/${encodeURIComponent(meetingId)}`)).data; }
      catch (error) {
        if (!(error instanceof WebexApiError) || ![404, 409, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      }
      attempt += 1;
    }
    return null;
  }

  private resolveMeetingRoomId(meeting: any) {
    const direct = configured(meeting?.roomId);
    if (direct) return direct;
    const scheduledId = configured(meeting?.scheduledMeetingId);
    if (scheduledId && this.state.schedules[scheduledId]) return this.state.schedules[scheduledId].roomId;
    const seriesId = configured(meeting?.meetingSeriesId);
    if (seriesId) return Object.values(this.state.schedules).find((item) => item.seriesId === seriesId)?.roomId ?? '';
    return '';
  }

  private async processMeeting(meeting: any) {
    const meetingType = configured(meeting?.meetingType);
    const state = configured(meeting?.state);
    const meetingId = configured(meeting?.id);
    if (!meetingId) return;
    if (meetingType === 'meetingSeries') {
      const seriesRoomId = this.resolveMeetingRoomId(meeting);
      const token = await this.getAccessToken();
      const from = new Date().toISOString();
      const to = new Date(Date.now() + this.cfg.schedulingHorizonDays * 24 * 60 * 60_000).toISOString();
      const occurrences = await webexList(token, `/meetings?meetingSeriesId=${encodeURIComponent(meetingId)}&meetingType=scheduledMeeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
      for (const occurrence of occurrences) {
        await this.processMeeting(seriesRoomId && !configured(occurrence?.roomId) ? { ...occurrence, roomId: seriesRoomId } : occurrence);
      }
      return;
    }
    const roomId = this.resolveMeetingRoomId(meeting);
    if (!roomId || !this.state.rooms[roomId]?.covered) return;
    if (meetingType === 'scheduledMeeting') {
      if (['ended', 'missed'].includes(state)) this.deleteSchedule(meetingId);
      else this.upsertSchedule(meeting, roomId);
      await this.persist();
      return;
    }
    if (isJoinableMeeting(meeting)) await this.joinDiscoveredMeeting(meeting, roomId);
    else if (isTerminalMeeting(meeting)) await this.endMeeting(meetingId, roomId);
  }

  private upsertSchedule(meeting: any, roomId: string) {
    const start = configured(meeting?.start);
    const meetingId = configured(meeting?.id);
    if (!start || !meetingId || !Number.isFinite(Date.parse(start))) return;
    const webLink = configured(meeting?.webLink);
    const sipAddress = configured(meeting?.sipAddress);
    const destination = meetingId || sipAddress || webLink;
    this.state.schedules[meetingId] = {
      id: meetingId,
      seriesId: configured(meeting?.meetingSeriesId) || undefined,
      roomId,
      title: configured(meeting?.title) || undefined,
      start,
      end: configured(meeting?.end) || undefined,
      destination,
      webLink: webLink || undefined,
      sipAddress: sipAddress || undefined,
      password: configured(meeting?.password) || undefined,
      fallbackUntil: new Date(Date.parse(start) + this.cfg.scheduledStartGraceMinutes * 60_000).toISOString(),
      updatedAt: nowIso(),
    };
    this.armSchedule(meetingId);
  }

  private rebuildScheduleTimers() { for (const meetingId of Object.keys(this.state.schedules)) this.armSchedule(meetingId); }

  private armSchedule(meetingId: string, retryMs?: number) {
    const schedule = this.state.schedules[meetingId];
    if (!schedule) return;
    const previous = this.scheduleTimers.get(meetingId);
    if (previous) clearTimeout(previous);
    const delayMs = retryMs ?? Math.max(0, Date.parse(schedule.start) - Date.now());
    if (Date.now() > Date.parse(schedule.fallbackUntil)) return;
    const maxTimeoutMs = 2_147_000_000;
    const callback = delayMs > maxTimeoutMs
      ? () => this.armSchedule(meetingId)
      : () => this.pollScheduledMeeting(meetingId).catch((error) => this.logFailure(`scheduled poll ${meetingId}`, error));
    const timer = setTimeout(callback, Math.min(delayMs, maxTimeoutMs));
    timer.unref?.();
    this.scheduleTimers.set(meetingId, timer);
  }

  private async pollScheduledMeeting(meetingId: string) {
    this.scheduleTimers.delete(meetingId);
    const schedule = this.state.schedules[meetingId];
    if (!schedule || Date.now() > Date.parse(schedule.fallbackUntil)) return;
    const token = await this.getAccessToken();
    const from = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const active = await this.listMeetingInstances(token, from, to);
    for (const meeting of active) await this.processMeeting(meeting);
    const joined = Object.values(this.state.sessions).some((session) => session.invitation.meetingId && session.roomId === schedule.roomId && ACTIVE_STATES.has(session.state));
    if (!joined) this.armSchedule(meetingId, 15_000);
  }

  private deleteSchedule(meetingId: string) {
    const timer = this.scheduleTimers.get(meetingId);
    if (timer) clearTimeout(timer);
    this.scheduleTimers.delete(meetingId);
    delete this.state.schedules[meetingId];
  }

  private pruneSchedules() {
    const cutoff = Date.now() - 60 * 60_000;
    for (const schedule of Object.values(this.state.schedules)) {
      const expiry = Date.parse(schedule.end ?? schedule.fallbackUntil);
      if (expiry < cutoff) this.deleteSchedule(schedule.id);
    }
    for (const pending of Object.values(this.state.pending)) if (Date.parse(pending.expiresAt) < Date.now()) delete this.state.pending[pending.meetingId];
  }

  async joinDiscoveredMeeting(meeting: any, roomId = this.resolveMeetingRoomId(meeting)) {
    // Startup reconciliation may discover an active meeting before startTask
    // resolves. Awaiting that same task here would deadlock startup.
    if (!this.enabled) await this.start();
    if (!roomId || !this.state.rooms[roomId]?.covered) return { accepted: false, state: 'failed', error_code: 'space_not_covered' };
    const invitation = createDiscoveredInvitation(meeting, roomId);
    if (!invitation) return { accepted: false, state: 'failed', error_code: 'meeting_destination_invalid' };
    const existing = Object.values(this.state.sessions).find((session) =>
      ACTIVE_STATES.has(session.state) && (session.invitation.meetingId === invitation.meetingId || session.roomId === roomId)
    );
    if (existing?.invitation.meetingId === invitation.meetingId) return this.browserReadyResult(existing);
    const activeCount = Object.values(this.state.sessions).filter((session) => ACTIVE_STATES.has(session.state)).length;
    if (existing || activeCount >= this.cfg.maxConcurrentMeetings) {
      this.state.pending[invitation.meetingId!] = {
        meetingId: invitation.meetingId!, roomId, destination: invitation.destination,
        webLink: invitation.joinLink, password: invitation.password, meetingNumber: invitation.meetingNumber,
        expiresAt: configured(meeting?.end) || new Date(Date.now() + 4 * 60 * 60_000).toISOString(), updatedAt: nowIso(),
      };
      await this.persist();
      return { accepted: false, state: 'pending', error_code: existing ? 'active_meeting_requires_leave' : 'capacity_reached' };
    }
    delete this.state.pending[invitation.meetingId!];
    return this.joinTarget(roomId, undefined, invitation, 'automatic');
  }

  private async drainPending() {
    for (const pending of Object.values(this.state.pending).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      if (Date.parse(pending.expiresAt) < Date.now()) { delete this.state.pending[pending.meetingId]; continue; }
      const result = await this.joinDiscoveredMeeting({
        id: pending.meetingId, roomId: pending.roomId, webLink: pending.webLink,
        password: pending.password, meetingNumber: pending.meetingNumber, end: pending.expiresAt,
      }, pending.roomId);
      if (result.accepted) delete this.state.pending[pending.meetingId];
    }
  }

  async join(input: any) {
    await this.start();
    const roomId = configured(input?.room_id);
    const parentId = configured(input?.parent_id) || undefined;
    const invitation = createInvitation(input?.meeting_link, input?.meeting_password);
    if (!roomId || !invitation) return { accepted: false, state: 'failed', error_code: 'meeting_credentials_invalid' };
    return this.joinTarget(roomId, parentId, invitation, 'manual');
  }

  private async joinTarget(roomId: string, parentId: string | undefined, invitation: Invitation, source: 'manual' | 'automatic') {
    if (!this.enabled) return { accepted: false, state: 'failed', error_code: 'meeting_join_unavailable' };
    const existing = Object.values(this.state.sessions).find((session) => session.roomId === roomId && ACTIVE_STATES.has(session.state));
    if (existing) {
      if (existing.invitation.destination === invitation.destination || existing.invitation.meetingId === invitation.meetingId) return this.browserReadyResult(existing);
      return { accepted: false, state: existing.state, error_code: 'active_meeting_requires_leave' };
    }
    if (Object.values(this.state.sessions).filter((session) => ACTIVE_STATES.has(session.state)).length >= this.cfg.maxConcurrentMeetings) {
      return { accepted: false, state: 'failed', error_code: 'capacity_reached' };
    }
    const session: Session = {
      id: randomUUID(), roomId, parentId, source, invitation, state: 'preparing', recoveryAttempts: 0,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    this.state.sessions[session.id] = session;
    await this.persist();
    try {
      if (!this.cfg.requireBrowserReview) await this.transition(session, 'joining');
      await this.launch(session);
      if (this.cfg.requireBrowserReview) await this.transition(session, 'ready_for_browser');
      return this.browserReadyResult(session);
    } catch (error) {
      const code = safeErrorCode(error);
      await this.fail(session, code);
      return { accepted: false, session_id: session.id, state: 'failed', error_code: code };
    }
  }

  private browserReadyResult(session: Session) {
    const needsBrowserAction = this.cfg.requireBrowserReview && session.state === 'ready_for_browser';
    return {
      accepted: true, session_id: session.id, state: session.state,
      ...(needsBrowserAction ? {
        browser_profile: this.cfg.browserProfile, tab_id: session.tabId, tab_label: session.tabLabel,
        next_action: 'Call inspect_webex_meeting_runner with this session_id, choose the visible join action from its fresh snapshot, then call act_webex_meeting_runner with that ref.',
      } : {}),
    };
  }

  async leave(roomId: string) {
    const session = Object.values(this.state.sessions).find((item) => item.roomId === roomId && ACTIVE_STATES.has(item.state));
    if (!session) return { accepted: false, state: 'left', error_code: 'no_active_meeting' };
    session.leaveRequested = true;
    await this.transition(session, 'leaving');
    const timer = setTimeout(() => { if (session.state === 'leaving') this.completeLeave(session).catch(() => undefined); }, 15_000);
    timer.unref?.();
    return { accepted: true, state: 'leaving' };
  }

  status(roomId?: string) {
    const rooms = Object.values(this.state.rooms).filter((room) => !roomId || room.roomId === roomId).map((room) => ({
      room_id: room.roomId, title: room.title, covered: room.covered, error_code: room.lastError,
    }));
    const upcoming = Object.values(this.state.schedules).filter((item) => !roomId || item.roomId === roomId).map((item) => ({
      meeting_id: item.id, room_id: item.roomId, title: item.title, start: item.start, end: item.end,
    }));
    const active = Object.values(this.state.sessions).filter((item) => ACTIVE_STATES.has(item.state) && (!roomId || item.roomId === roomId)).map((item) => ({
      session_id: item.id, meeting_id: item.invitation.meetingId, room_id: item.roomId, state: item.state, source: item.source,
    }));
    const failures = Object.values(this.state.sessions)
      .filter((item) => item.state === 'failed' && (!roomId || item.roomId === roomId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
      .map((item) => ({
        session_id: item.id,
        meeting_id: item.invitation.meetingId,
        room_id: item.roomId,
        error_code: safePublicFailureCode(item.errorCode),
        updated_at: item.updatedAt,
      }));
    return { enabled: this.enabled, rooms, upcoming, active, failures, pending: Object.keys(this.state.pending).length };
  }

  async inspectRunner(sessionId: string) {
    await this.start();
    const session = this.state.sessions[configured(sessionId)];
    if (!session) return { ok: false, error_code: 'meeting_session_not_found', retryable: false };
    if (!ACTIVE_STATES.has(session.state) || !session.tabId) return { ok: false, state: session.state, error_code: 'meeting_runner_not_ready', retryable: false };
    try {
      const snapshot: any = await this.browser.snapshot(session.tabId);
      const targetId = configured(snapshot?.targetId);
      if (!targetId) throw new BrowserControlError('Meeting runner snapshot did not return a targetId', 'browser_control_unavailable');
      session.inspectedTargetId = targetId;
      session.inspectedRefs = snapshotRefs(snapshot);
      return { ok: true, session_id: session.id, state: session.state, snapshot: snapshot.snapshot ?? snapshot.nodes ?? '', refs: snapshot.refs ?? {}, target_binding: 'internal', truncated: Boolean(snapshot.truncated) };
    } catch (error) {
      session.inspectedTargetId = undefined;
      session.inspectedRefs = undefined;
      this.logFailure('runner inspection', error);
      return { ok: false, state: session.state, error_code: 'meeting_runner_inspection_failed', retryable: true };
    }
  }

  async actOnRunner(sessionId: string, ref: string) {
    await this.start();
    const session = this.state.sessions[configured(sessionId)];
    if (!session) return { ok: false, error_code: 'meeting_session_not_found', retryable: false };
    if (session.state !== 'ready_for_browser' || !session.tabId) return { ok: false, state: session.state, error_code: 'meeting_runner_not_ready', retryable: false };
    const normalizedRef = configured(ref);
    if (!/^(?:\d+|e\d+|ax\d+)$/.test(normalizedRef)) return { ok: false, state: session.state, error_code: 'meeting_runner_ref_invalid', retryable: true };
    if (!session.inspectedTargetId || !session.inspectedRefs?.includes(normalizedRef)) return { ok: false, state: session.state, error_code: 'meeting_runner_snapshot_required', retryable: true };
    const targetId = session.inspectedTargetId;
    session.inspectedTargetId = undefined;
    session.inspectedRefs = undefined;
    try {
      await this.browser.click(targetId, normalizedRef);
      return { ok: true, session_id: session.id, state: session.state, action: 'click_submitted', next_action: 'Inspect the meeting runner again to verify its visible status.' };
    } catch (error) {
      return { ok: false, state: session.state, ...browserActionFailure(error) };
    }
  }

  async handleRunnerRoute(req: any, res: any) {
    if (!isLoopback(req.socket?.remoteAddress)) { res.statusCode = 403; res.end('Loopback only'); return true; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/webex-auto-join\/runner\/([^/]+)(?:\/(bootstrap|events|control))?$/);
    if (!match) return false;
    const [, sessionId, action] = match;
    const session = this.state.sessions[sessionId];
    if (!session) return sendJson(res, 404, { error: 'not_found' }), true;
    const cookie = parseCookies(req.headers?.cookie).webex_auto_join_session;
    const cookieSession = cookie ? this.runnerCookies.get(cookie) : null;
    const authenticated = Boolean(cookieSession && cookieSession.sessionId === sessionId && cookieSession.expiresAt > Date.now());
    if (!action) {
      if (authenticated) {
        if (url.searchParams.has('sdk')) return this.serveAsset(res, this.assets.sdk ?? process.env.MEETING_JOIN_WEBEX_SDK_PATH, 'application/javascript; charset=utf-8', 'webex_sdk_asset_unavailable');
        if (url.searchParams.has('asset')) return this.serveAsset(res, this.assets.runner ?? process.env.MEETING_JOIN_RUNNER_PATH, 'application/javascript; charset=utf-8', 'runner_asset_unavailable');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClaw Webex Auto Join</title></head><body data-autostart="${this.cfg.requireBrowserReview ? 'false' : 'true'}"><main><h1>Webex meeting</h1><p id="meeting-status" role="status" aria-live="polite">Ready to join with the configured Webex user.</p><button id="join-meeting" type="button">Join Webex meeting</button></main><script src="${url.pathname}?sdk=1"></script><script src="${url.pathname}?asset=1"></script></body></html>`);
        return true;
      }
      const nonce = url.searchParams.get('nonce');
      const nonceSession = nonce ? this.runnerNonces.get(nonce) : null;
      if (!nonceSession || nonceSession.sessionId !== sessionId || nonceSession.expiresAt < Date.now()) return sendJson(res, 403, { error: 'unauthorized' }), true;
      this.runnerNonces.delete(nonce!);
      const sessionCookie = randomBytes(24).toString('base64url');
      this.runnerCookies.set(sessionCookie, { sessionId, expiresAt: Date.now() + 60 * 60_000 });
      res.statusCode = 302;
      res.setHeader('Set-Cookie', `webex_auto_join_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/webex-auto-join/runner/${sessionId}`);
      res.setHeader('Location', `/webex-auto-join/runner/${sessionId}`);
      res.end();
      return true;
    }
    if (!authenticated) return sendJson(res, 403, { error: 'unauthorized' }), true;
    if (action === 'bootstrap' && req.method === 'GET') {
      try { return sendJson(res, 200, { accessToken: await this.getAccessToken(), destination: session.invitation.destination, joinLink: session.invitation.joinLink, password: session.invitation.password, meetingId: session.invitation.meetingId, sessionId }), true; }
      catch (error) { return sendJson(res, 503, { error: safeErrorCode(error) }), true; }
    }
    if (action === 'control' && req.method === 'GET') return sendJson(res, 200, { leave: Boolean(session.leaveRequested) }), true;
    if (action === 'events' && req.method === 'POST') {
      try { await this.handleRunnerEvent(session, await readJsonBody(req)); return sendJson(res, 200, { ok: true }), true; }
      catch { return sendJson(res, 400, { error: 'invalid_event' }), true; }
    }
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return true;
  }

  private async serveAsset(res: any, filename: string | undefined, contentType: string, errorCode: string) {
    try {
      if (!filename) throw new Error('asset path missing');
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.end(await readFile(filename));
    } catch { sendJson(res, 500, { error: errorCode }); }
    return true;
  }

  private async handleRunnerEvent(session: Session, event: any) {
    const type = configured(event?.type);
    if (type === 'joining') await this.transition(session, 'joining');
    else if (type === 'waiting_for_admission') await this.transition(session, 'waiting_for_admission');
    else if (type === 'joined') { session.recoveryAttempts = 0; await this.transition(session, 'joined'); }
    else if (type === 'left') await this.completeLeave(session);
    else if (type === 'ended') await this.completeEnd(session);
    else if (type === 'error') {
      const code = configured(event?.code) || 'meeting_join_failed';
      if (session.recoveryAttempts > 0 && session.recoveryAttempts < this.cfg.recoveryMaxAttempts) {
        await this.transition(session, 'interrupted');
        this.recover(session).catch(() => this.fail(session, code));
      } else await this.fail(session, code);
    } else if (type === 'heartbeat') { session.updatedAt = nowIso(); await this.persist(); }
  }

  private async launch(session: Session) {
    await this.getAccessToken();
    await this.browser.start();
    const nonce = randomBytes(24).toString('base64url');
    this.runnerNonces.set(nonce, { sessionId: session.id, expiresAt: Date.now() + 60_000 });
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? 18789);
    const runnerUrl = `http://127.0.0.1:${port}/webex-auto-join/runner/${session.id}?nonce=${encodeURIComponent(nonce)}`;
    session.tabLabel = `meeting:${Buffer.from(session.roomId).toString('base64url').slice(0, 20)}`;
    session.inspectedTargetId = undefined;
    session.inspectedRefs = undefined;
    session.tabId = await this.browser.open(runnerUrl, session.tabLabel);
    if (!session.tabId) throw new Error('Browser did not return a meeting tab identifier');
    session.updatedAt = nowIso();
    await this.persist();
  }

  private async recoverActiveSessions() {
    for (const session of Object.values(this.state.sessions)) {
      if (!ACTIVE_STATES.has(session.state) || session.state === 'leaving') continue;
      this.recover(session).catch((error) => this.logFailure('session recovery', error));
    }
  }

  private async checkHeartbeats() {
    const cutoff = Date.now() - 45_000;
    for (const session of Object.values(this.state.sessions)) {
      if (!['joining', 'waiting_for_admission', 'joined'].includes(session.state) || Date.parse(session.updatedAt) >= cutoff) continue;
      await this.transition(session, 'interrupted');
      this.recover(session).catch(() => this.fail(session, 'runner_heartbeat_lost'));
    }
  }

  private async recover(session: Session) {
    while (session.recoveryAttempts < this.cfg.recoveryMaxAttempts && ACTIVE_STATES.has(session.state)) {
      session.recoveryAttempts += 1;
      await this.transition(session, 'recovering');
      try {
        await this.browser.close(session.tabId);
        if (!this.cfg.requireBrowserReview) await this.transition(session, 'joining');
        await this.launch(session);
        if (this.cfg.requireBrowserReview) await this.transition(session, 'ready_for_browser');
        return;
      } catch {
        await delay(this.cfg.recoveryBaseDelayMs * 2 ** (session.recoveryAttempts - 1) + Math.floor(Math.random() * 250));
      }
    }
    await this.fail(session, 'recovery_exhausted');
  }

  private async endMeeting(meetingId: string, roomId: string) {
    delete this.state.pending[meetingId];
    this.deleteSchedule(configured(Object.values(this.state.schedules).find((schedule) => schedule.roomId === roomId && (schedule.id === meetingId || schedule.seriesId === meetingId))?.id));
    const session = Object.values(this.state.sessions).find((item) => item.invitation.meetingId === meetingId || item.roomId === roomId);
    if (session && ACTIVE_STATES.has(session.state)) await this.completeEnd(session);
    await this.persist();
  }

  private async removeMeeting(meetingId: string, roomId: string) {
    if (meetingId) this.deleteSchedule(meetingId);
    if (meetingId) delete this.state.pending[meetingId];
    const session = Object.values(this.state.sessions).find((item) => item.invitation.meetingId === meetingId);
    if (roomId || session) await this.endMeeting(meetingId, roomId || session?.roomId || '');
    await this.persist();
  }

  private async completeLeave(session: Session) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = undefined;
    await this.transition(session, 'left');
    await this.drainPending();
  }

  private async completeEnd(session: Session) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = undefined;
    await this.transition(session, 'ended');
    await this.drainPending();
  }

  private async fail(session: Session, code: string) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = undefined;
    await this.transition(session, 'failed', safePublicFailureCode(code));
    await this.drainPending();
  }

  private async transition(session: Session, next: string, errorCode?: string) {
    session.state = next;
    session.updatedAt = nowIso();
    if (next === 'failed') session.errorCode = safePublicFailureCode(errorCode);
    else if (!['interrupted', 'recovering'].includes(next)) session.errorCode = undefined;
    if (['left', 'ended', 'failed'].includes(next)) session.leaveRequested = false;
    await this.persist();
    if (next === 'joined' && this.cfg.notificationMode === 'join-and-failure') {
      const message = session.source === 'automatic' ? 'Joined the Webex meeting automatically.' : 'Joined the Webex meeting.';
      await this.notifyOnce(`joined:${session.invitation.meetingId ?? session.id}`, session.roomId, message)
        .catch((error) => this.logFailure('joined notification', error));
    } else if (next === 'failed') {
      await this.notifyOnce(`failed:${session.invitation.meetingId ?? session.id}`, session.roomId, `Could not join or continue the Webex meeting (${errorCode ?? 'meeting_join_failed'}).`)
        .catch((error) => this.logFailure('failure notification', error));
    }
  }

  private async notifyOnce(key: string, roomId: string, markdown: string) {
    if (this.state.notifications[key]) return;
    await this.messages.send(roomId, markdown);
    this.state.notifications[key] = nowIso();
    await this.persist();
  }

  private invalidateRunnerAuth(sessionId: string) {
    for (const [nonce, value] of this.runnerNonces) if (value.sessionId === sessionId) this.runnerNonces.delete(nonce);
    for (const [cookie, value] of this.runnerCookies) if (value.sessionId === sessionId) this.runnerCookies.delete(cookie);
  }

  private async getAccessToken() {
    if (!this.store) throw new Error('auto-join state unavailable');
    const cached = this.state.token;
    if (cached && cached.expiresAt > Date.now() + 120_000) return cached.accessToken;
    const refreshToken = cached?.refreshToken ?? this.cfg.attendeeRefreshToken;
    if (!refreshToken || !this.cfg.attendeeClientId || !this.cfg.attendeeClientSecret) throw new Error('meeting OAuth credentials are unavailable');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.cfg.attendeeClientId, client_secret: this.cfg.attendeeClientSecret });
    const response = await fetch(`${WEBEX_API}/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw new Error(`OAuth refresh failed (${response.status})`);
    const token: any = await response.json();
    if (!token.access_token) throw new Error('OAuth refresh response incomplete');
    this.state.token = { accessToken: token.access_token, refreshToken: token.refresh_token ?? refreshToken, expiresAt: Date.now() + Number(token.expires_in ?? 0) * 1000 };
    await this.persist();
    return token.access_token;
  }

  private async persist() { if (this.store) await this.store.save(this.state); }
  private logFailure(context: string, error: unknown) { this.log?.warn?.(`[webex-auto-join] ${context}: ${safeErrorCode(error)}`); }
}

export {
  BrowserControl,
  BrowserControlError,
  browserActionFailure,
  createDiscoveredInvitation,
  createInvitation,
  EncryptedState,
  safeErrorCode,
  snapshotRefs,
};
