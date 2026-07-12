import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WEBEX_API = 'https://webexapis.com/v1';
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
  joinLink: string;
  password: string;
  meetingNumber?: string;
  discoveredAt: string;
};

type Session = {
  id: string;
  roomId: string;
  parentId?: string;
  invitation: Invitation;
  state: string;
  lastNotifiedState?: string;
  tabId?: string;
  tabLabel?: string;
  recoveryAttempts: number;
  leaveRequested?: boolean;
  createdAt: string;
  updatedAt: string;
};

type PersistedState = {
  version: 1;
  sessions: Record<string, Session>;
  token?: { accessToken: string; refreshToken: string; expiresAt: number };
};

function nowIso() {
  return new Date().toISOString();
}

function safeErrorCode(error: unknown) {
  const explicitCode = String((error as any)?.code ?? '');
  if (explicitCode === 'browser_control_unavailable' || explicitCode === 'browser_control_unauthorized') {
    return explicitCode;
  }
  const message = String((error as any)?.message ?? error ?? '').toLowerCase();
  if (message.includes('captcha')) return 'captcha_required';
  if (message.includes('password')) return 'meeting_password_rejected';
  if (message.includes('401') || message.includes('token')) return 'oauth_unavailable';
  if (message.includes('capacity')) return 'capacity_reached';
  if (message.includes('history')) return 'meeting_history_unavailable';
  return 'meeting_join_failed';
}

function isLoopback(address?: string) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function parseCookies(raw?: string) {
  return Object.fromEntries(
    String(raw ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
  );
}

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
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
  try {
    parsed = new URL(String(joinLink ?? '').trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'webex.com' || parsed.hostname.endsWith('.webex.com'))) {
    return null;
  }
  const normalizedPassword = String(password ?? '').trim();
  if (!normalizedPassword) return null;
  return { joinLink: parsed.toString(), password: normalizedPassword, discoveredAt: nowIso() };
}

class EncryptedState {
  private readonly key: Buffer;
  readonly statePath: string;

  constructor(rawKey: string | undefined, statePath: string) {
    const key = rawKey ? Buffer.from(rawKey, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) throw new Error('MEETING_JOIN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    this.key = key;
    this.statePath = statePath;
  }

  async load(): Promise<PersistedState> {
    try {
      const envelope = JSON.parse(await readFile(this.statePath, 'utf8'));
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed = JSON.parse(plain.toString('utf8'));
      return {
        version: 1,
        sessions: parsed.sessions ?? {},
        token: parsed.token,
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { version: 1, sessions: {} };
      throw new Error('Meeting state could not be decrypted; refusing to use stored credentials');
    }
  }

  async save(state: PersistedState) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({
      v: 1,
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

class BrowserControl {
  constructor(private readonly profile: string) {}

  private get baseUrl() {
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? 18789) + 2;
    return `http://127.0.0.1:${port}`;
  }

  private async request(method: string, pathname: string, body?: unknown) {
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (!token) throw Object.assign(new Error('OPENCLAW_GATEWAY_TOKEN is required for browser control'), { code: 'browser_control_unauthorized' });
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}${pathname.includes('?') ? '&' : '?'}profile=${encodeURIComponent(this.profile)}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw Object.assign(new Error('OpenClaw browser control is unreachable', { cause }), { code: 'browser_control_unavailable' });
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? 'browser_control_unauthorized'
        : 'browser_control_unavailable';
      throw Object.assign(new Error(`Browser control ${method} ${pathname} failed (${response.status})`), { code });
    }
    return response.json().catch(() => ({}));
  }

  start() {
    return this.request('POST', '/start?headless=true');
  }

  async open(url: string, label: string) {
    const result: any = await this.request('POST', '/tabs/open', { url });
    const tabId = result.suggestedTargetId ?? result.targetId ?? result.id;
    if (tabId) {
      await this.request('POST', '/tabs/action', { action: 'label', targetId: tabId, label }).catch(() => undefined);
    }
    return tabId;
  }

  async close(tabId?: string) {
    if (!tabId) return;
    await this.request('DELETE', `/tabs/${encodeURIComponent(tabId)}`).catch(() => undefined);
  }
}

export class MeetingJoinService {
  private state!: PersistedState;
  private store: EncryptedState | null = null;
  private runnerNonces = new Map<string, { sessionId: string; expiresAt: number }>();
  private runnerCookies = new Map<string, { sessionId: string; expiresAt: number }>();
  private enabled = false;
  private startTask: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cfg: any;
  private browser: BrowserControl;

  constructor(private readonly runtime: any, config: any, private readonly log: any = console) {
    this.cfg = {
      maxConcurrentMeetings: config?.maxConcurrentMeetings ?? 4,
      browserProfile: config?.browserProfile ?? 'meeting-join',
      recoveryMaxAttempts: config?.recoveryMaxAttempts ?? 5,
      recoveryBaseDelayMs: config?.recoveryBaseDelayMs ?? 1000,
    };
    this.browser = new BrowserControl(this.cfg.browserProfile);
  }

  async start() {
    if (this.startTask) return this.startTask;
    this.startTask = this.startInternal();
    return this.startTask;
  }

  private async startInternal() {
    const statePath = path.join(process.env.OPENCLAW_STATE_DIR ?? '/home/node/.openclaw', 'meeting-join-state.enc');
    try {
      this.store = new EncryptedState(process.env.MEETING_JOIN_ENCRYPTION_KEY, statePath);
      this.state = await this.store.load();
      await this.getAccessToken();
      this.enabled = true;
      this.heartbeatTimer = setInterval(() => this.checkHeartbeats().catch(() => undefined), 15_000);
      await this.recoverActiveSessions();
    } catch (error) {
      this.enabled = false;
      this.log?.error?.(`[meeting-join] startup disabled: ${safeErrorCode(error)}`);
    }
  }

  async stop() {
    if (!this.enabled) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const session of Object.values(this.state.sessions)) {
      if (!ACTIVE_STATES.has(session.state)) continue;
      await this.browser.close(session.tabId);
      session.tabId = undefined;
      session.state = session.state === 'leaving' ? 'left' : 'interrupted';
      session.updatedAt = nowIso();
    }
    await this.persist().catch(() => undefined);
  }

  async join(input: any) {
    await this.start();
    const roomId = String(input?.room_id ?? '').trim();
    const parentId = String(input?.parent_id ?? '').trim() || undefined;
    const invitation = createInvitation(input?.meeting_link, input?.meeting_password);
    if (!roomId || !invitation) {
      return { accepted: false, state: 'failed', error_code: 'meeting_credentials_invalid' };
    }
    if (!this.enabled) return { accepted: false, state: 'failed', error_code: 'meeting_join_unavailable' };

    const existing = Object.values(this.state.sessions).find((session) => session.roomId === roomId && ACTIVE_STATES.has(session.state));
    if (existing) {
      if (existing.invitation.joinLink === invitation.joinLink) {
        return this.browserReadyResult(existing);
      }
      return { accepted: false, state: existing.state, error_code: 'active_meeting_requires_leave' };
    }
    if (Object.values(this.state.sessions).filter((session) => ACTIVE_STATES.has(session.state)).length >= this.cfg.maxConcurrentMeetings) {
      return { accepted: false, state: 'failed', error_code: 'capacity_reached' };
    }

    const session: Session = {
      id: randomUUID(),
      roomId,
      parentId,
      invitation,
      state: 'preparing',
      recoveryAttempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.state.sessions[session.id] = session;
    await this.persist();
    await this.transition(session, 'preparing');
    try {
      await this.launch(session);
      await this.transition(session, 'ready_for_browser');
      return this.browserReadyResult(session);
    } catch (error) {
      const code = safeErrorCode(error);
      await this.fail(session, code);
      return { accepted: false, session_id: session.id, state: 'failed', error_code: code };
    }
  }

  private browserReadyResult(session: Session) {
    const needsBrowserAction = session.state === 'ready_for_browser';
    return {
      accepted: true,
      session_id: session.id,
      state: session.state,
      ...(needsBrowserAction ? {
        browser_profile: this.cfg.browserProfile,
        tab_id: session.tabId,
        tab_label: session.tabLabel,
        next_action: 'Inspect this tab with the browser tool and activate Join Webex meeting when the page is ready.',
      } : {}),
    };
  }

  async leave(roomId: string) {
    const session = Object.values(this.state.sessions).find((item) => item.roomId === roomId && ACTIVE_STATES.has(item.state));
    if (!session) return { accepted: false, state: 'left', error_code: 'no_active_meeting' };
    session.leaveRequested = true;
    await this.transition(session, 'leaving');
    setTimeout(() => {
      if (session.state === 'leaving') this.completeLeave(session).catch(() => undefined);
    }, 15_000).unref?.();
    return { accepted: true, state: 'leaving' };
  }

  async handleRunnerRoute(req: any, res: any) {
    if (!isLoopback(req.socket?.remoteAddress)) {
      res.statusCode = 403;
      res.end('Loopback only');
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/meeting-join\/runner\/([^/]+)(?:\/(bootstrap|events|control))?$/);
    if (!match) return false;
    const [, sessionId, action] = match;
    const session = this.state?.sessions?.[sessionId];
    if (!session) return sendJson(res, 404, { error: 'not_found' }), true;

    const cookie = parseCookies(req.headers?.cookie).meeting_join_session;
    const cookieSession = cookie ? this.runnerCookies.get(cookie) : null;
    const authenticated = Boolean(cookieSession && cookieSession.sessionId === sessionId && cookieSession.expiresAt > Date.now());

    if (!action) {
      if (authenticated) {
        if (url.searchParams.has('sdk')) {
          try {
            const sdkPath = process.env.MEETING_JOIN_WEBEX_SDK_PATH ?? '/app/node_modules/webex/umd/webex.min.js';
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(await readFile(sdkPath));
          } catch {
            sendJson(res, 500, { error: 'webex_sdk_asset_unavailable' });
          }
          return true;
        }
        if (url.searchParams.has('asset')) {
          try {
            const runnerPath = process.env.MEETING_JOIN_RUNNER_PATH ?? '/app/plugins/meeting-join/dist/runner.js';
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(await readFile(runnerPath));
          } catch {
            sendJson(res, 500, { error: 'runner_asset_unavailable' });
          }
          return true;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Webex Meeting Runner</title>
</head>
<body>
  <main>
    <h1>Webex meeting</h1>
    <p id="meeting-status" role="status" aria-live="polite">Ready to join with the configured Webex user.</p>
    <button id="join-meeting" type="button">Join Webex meeting</button>
  </main>
  <script src="${url.pathname}?sdk=1"></script>
  <script src="${url.pathname}?asset=1"></script>
</body>
</html>`);
        return true;
      }
      const nonce = url.searchParams.get('nonce');
      const nonceSession = nonce ? this.runnerNonces.get(nonce) : null;
      if (!nonceSession || nonceSession.sessionId !== sessionId || nonceSession.expiresAt < Date.now()) return sendJson(res, 403, { error: 'unauthorized' }), true;
      this.runnerNonces.delete(nonce!);
      const sessionCookie = randomBytes(24).toString('base64url');
      this.runnerCookies.set(sessionCookie, { sessionId, expiresAt: Date.now() + 60 * 60_000 });
      res.statusCode = 302;
      res.setHeader('Set-Cookie', `meeting_join_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/meeting-join/runner/${sessionId}`);
      res.setHeader('Location', `/meeting-join/runner/${sessionId}`);
      res.end();
      return true;
    }
    if (!authenticated) return sendJson(res, 403, { error: 'unauthorized' }), true;
    if (action === 'bootstrap' && req.method === 'GET') {
      try {
        return sendJson(res, 200, { accessToken: await this.getAccessToken(), joinLink: session.invitation.joinLink, password: session.invitation.password, sessionId }), true;
      } catch (error) {
        return sendJson(res, 503, { error: safeErrorCode(error) }), true;
      }
    }
    if (action === 'control' && req.method === 'GET') return sendJson(res, 200, { leave: Boolean(session.leaveRequested) }), true;
    if (action === 'events' && req.method === 'POST') {
      try {
        const event = await readJsonBody(req);
        await this.handleRunnerEvent(session, event);
        return sendJson(res, 200, { ok: true }), true;
      } catch {
        return sendJson(res, 400, { error: 'invalid_event' }), true;
      }
    }
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return true;
  }

  private async handleRunnerEvent(session: Session, event: any) {
    const type = String(event?.type ?? '');
    if (type === 'joining') await this.transition(session, 'joining');
    else if (type === 'waiting_for_admission') await this.transition(session, 'waiting_for_admission');
    else if (type === 'joined') {
      session.recoveryAttempts = 0;
      await this.transition(session, 'joined');
    }
    else if (type === 'left') await this.completeLeave(session);
    else if (type === 'ended') await this.transition(session, 'ended', true);
    else if (type === 'error') {
      const code = String(event?.code ?? 'meeting_join_failed');
      if (session.recoveryAttempts > 0 && session.recoveryAttempts < this.cfg.recoveryMaxAttempts) {
        await this.transition(session, 'interrupted');
        this.recover(session).catch(() => this.fail(session, code));
      } else {
        await this.fail(session, code);
      }
    }
    else if (type === 'heartbeat') {
      session.updatedAt = nowIso();
      await this.persist();
    }
  }

  private async launch(session: Session) {
    await this.getAccessToken();
    await this.browser.start();
    const nonce = randomBytes(24).toString('base64url');
    this.runnerNonces.set(nonce, { sessionId: session.id, expiresAt: Date.now() + 60_000 });
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? 18789);
    const runnerUrl = `http://127.0.0.1:${port}/meeting-join/runner/${session.id}?nonce=${encodeURIComponent(nonce)}`;
    session.tabLabel = `meeting:${Buffer.from(session.roomId).toString('base64url').slice(0, 20)}`;
    session.tabId = await this.browser.open(runnerUrl, session.tabLabel);
    if (!session.tabId) throw new Error('Browser did not return a meeting tab identifier');
    session.updatedAt = nowIso();
    await this.persist();
  }

  private async recoverActiveSessions() {
    if (!this.enabled) return;
    for (const session of Object.values(this.state.sessions)) {
      if (!ACTIVE_STATES.has(session.state) || session.state === 'leaving') continue;
      this.recover(session).catch((error) => this.log?.warn?.(`[meeting-join] recovery failure: ${safeErrorCode(error)}`));
    }
  }

  private async checkHeartbeats() {
    const cutoff = Date.now() - 45_000;
    for (const session of Object.values(this.state.sessions)) {
      if (!['joining', 'waiting_for_admission', 'joined'].includes(session.state)) continue;
      if (Date.parse(session.updatedAt) >= cutoff) continue;
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
        await this.launch(session);
        await this.transition(session, 'ready_for_browser');
        return;
      } catch {
        const delay = this.cfg.recoveryBaseDelayMs * 2 ** (session.recoveryAttempts - 1) + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    await this.fail(session, 'recovery_exhausted');
  }

  private async completeLeave(session: Session) {
    await this.browser.close(session.tabId);
    session.tabId = undefined;
    await this.transition(session, 'left', true);
  }

  private async fail(session: Session, code: string) {
    await this.browser.close(session.tabId);
    session.tabId = undefined;
    await this.transition(session, 'failed', true, code);
  }

  private async transition(session: Session, next: string, terminal = false, errorCode?: string) {
    session.state = next;
    session.updatedAt = nowIso();
    if (terminal) session.leaveRequested = false;
    await this.persist();
    if (session.lastNotifiedState === next) return;
    session.lastNotifiedState = next;
    await this.persist();
    await this.notify(session, next, errorCode).catch((error) => this.log?.warn?.(`[meeting-join] status notification failed: ${safeErrorCode(error)}`));
  }

  private async notify(session: Session, state: string, errorCode?: string) {
    const labels: Record<string, string> = {
      preparing: 'Preparing the Webex meeting session.',
      ready_for_browser: 'The secure meeting page is ready for browser review.',
      joining: 'Joining the Webex meeting.',
      waiting_for_admission: 'Waiting for the host to admit the meeting account.',
      joined: 'Joined the Webex meeting.',
      interrupted: 'The Webex meeting runner was interrupted; attempting recovery.',
      recovering: `Reconnecting to the Webex meeting (attempt ${session.recoveryAttempts}/${this.cfg.recoveryMaxAttempts}).`,
      leaving: 'Leaving the Webex meeting.',
      left: 'Left the Webex meeting.',
      ended: 'The Webex meeting ended.',
      failed: `Could not join or continue the Webex meeting (${errorCode ?? 'meeting_join_failed'}).`,
    };
    const markdown = labels[state];
    if (!markdown) return;
    const cfg = this.runtime?.config?.current?.() ?? {};
    const configuredToken = cfg?.channels?.webex?.token;
    const token = configuredToken && !String(configuredToken).startsWith('${')
      ? configuredToken
      : process.env.WEBEX_BOT_TOKEN;
    if (!token) throw new Error('Webex bot token is unavailable');
    const response = await fetch(`${WEBEX_API}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: session.roomId, markdown, ...(session.parentId ? { parentId: session.parentId } : {}) }),
    });
    if (!response.ok) throw new Error(`Webex status send failed (${response.status})`);
  }

  private async getAccessToken() {
    if (!this.store) throw new Error('meeting state unavailable');
    const cached = this.state.token;
    if (cached && cached.expiresAt > Date.now() + 120_000) return cached.accessToken;
    const refreshToken = cached?.refreshToken ?? process.env.MEETING_JOIN_REFRESH_TOKEN;
    const clientId = process.env.MEETING_JOIN_CLIENT_ID;
    const clientSecret = process.env.MEETING_JOIN_CLIENT_SECRET;
    if (!refreshToken || !clientId || !clientSecret) throw new Error('meeting OAuth credentials are unavailable');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
    const response = await fetch(`${WEBEX_API}/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw new Error(`OAuth refresh failed (${response.status})`);
    const token = await response.json() as any;
    if (!token.access_token || !token.refresh_token) throw new Error('OAuth refresh response incomplete');
    this.state.token = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + Number(token.expires_in ?? 0) * 1000 };
    await this.persist();
    await this.verifyMeetingIdentity(token.access_token);
    return token.access_token;
  }

  private async verifyMeetingIdentity(accessToken: string) {
    const expected = process.env.MEETING_JOIN_EXPECTED_EMAIL?.trim().toLowerCase();
    if (!expected) return;
    const response = await fetch(`${WEBEX_API}/people/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Meeting identity verification failed (${response.status})`);
    const person = await response.json() as any;
    if (String(person.emails?.[0] ?? '').toLowerCase() !== expected) throw new Error('Meeting OAuth identity does not match MEETING_JOIN_EXPECTED_EMAIL');
  }

  private async persist() {
    if (this.store) await this.store.save(this.state);
  }
}

export { createInvitation, EncryptedState, isLoopback, safeErrorCode };
