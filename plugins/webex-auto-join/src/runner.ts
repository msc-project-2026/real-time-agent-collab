declare global {
  interface Window { meetingJoinStarted?: boolean; Webex?: any }
}

import { noMediaAdapter } from './runner-media';

const base = window.location.pathname.replace(/\/$/, '');
let meeting: any;
let leaving = false;
let waitingForAdmission = false;
let stage = 'runner_start';

function setStatus(message: string) {
  const status = document.querySelector<HTMLElement>('#meeting-status');
  if (status) status.textContent = message;
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}/${path}`, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error(`Runner request failed (${response.status})`);
  return response.json();
}

async function event(type: string, code?: string, detail?: string) {
  await request('events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...(code ? { code } : {}), ...(detail ? { detail } : {}) }),
  });
}

function classify(error: unknown) {
  const message = String((error as any)?.message ?? error ?? '').toLowerCase();
  if (message.includes('captcha')) return 'captcha_required';
  if (message.includes('password required')) return 'meeting_password_required';
  if (message.includes('password')) return 'meeting_password_rejected';
  return 'meeting_join_failed';
}

function sanitizeDiagnostic(value: unknown) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(^|[^A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{32,}(?=$|[^A-Za-z0-9_+/=-])/g, '$1[redacted-value]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

// Webex SDK errors wrap the real failure on `.error` (see JoinMeetingError:
// `e.error=o`), so `sdk_code=2 / "Error Joining Meeting"` is only the generic
// outer shell. Walk the cause chain so the underlying locus/HTTP reason surfaces.
function errorChain(error: unknown, limit = 6): any[] {
  const seen = new Set<any>();
  const chain: any[] = [];
  let node: any = error;
  while (node != null && !seen.has(node) && chain.length < limit) {
    seen.add(node);
    chain.push(node);
    node = node?.error ?? node?.cause ?? node?.originalError ?? node?.wrappedError;
  }
  return chain;
}

function layerFields(item: any) {
  const body = item?.body ?? item?.data?.body ?? item?.data ?? {};
  return {
    name: sanitizeDiagnostic(item?.name),
    code: sanitizeDiagnostic(item?.code ?? item?.errorCode ?? item?.statusCode ?? item?.status ?? body?.errorCode ?? body?.code),
    message: sanitizeDiagnostic(item?.message ?? body?.message ?? body?.error ?? (typeof item === 'string' ? item : '')),
    sdkMessage: sanitizeDiagnostic(item?.sdkMessage),
    reason: sanitizeDiagnostic(item?.reason ?? body?.reason ?? body?.errorDescription),
  };
}

function diagnostic(error: unknown, errorStage = stage) {
  const chain = errorChain(error);
  const root = layerFields(chain[0] ?? {});
  if (!root.message) root.message = sanitizeDiagnostic(error);
  const parts = [
    `stage=${sanitizeDiagnostic(errorStage) || 'unknown'}`,
    ...(root.name ? [`name=${root.name}`] : []),
    ...(root.code ? [`sdk_code=${root.code}`] : []),
    ...(root.message ? [`message=${root.message}`] : []),
    ...(root.sdkMessage && root.sdkMessage !== root.message ? [`sdk_message=${root.sdkMessage}`] : []),
    ...(root.reason && root.reason !== root.message ? [`reason=${root.reason}`] : []),
  ];
  // Deeper layers carry the true cause the generic wrapper hides.
  for (let i = 1; i < chain.length; i++) {
    const layer = layerFields(chain[i]);
    const detail = layer.message || layer.reason || layer.sdkMessage;
    const fields = [
      ...(layer.name ? [`cause${i}_name=${layer.name}`] : []),
      ...(layer.code ? [`cause${i}_code=${layer.code}`] : []),
      ...(detail ? [`cause${i}_message=${detail}`] : []),
    ];
    if (fields.length) parts.push(...fields);
  }
  return parts.join('; ');
}

async function start() {
  if (window.meetingJoinStarted) return;
  window.meetingJoinStarted = true;
  const joinButton = document.querySelector<HTMLButtonElement>('#join-meeting');
  if (joinButton) joinButton.disabled = true;
  setStatus('Connecting to Webex…');
  try {
    stage = 'bootstrap';
    const boot = await request('bootstrap');
    await event('joining');
    setStatus('Authenticating the configured Webex user…');
    stage = 'sdk_initialization';
    const webex: any = window.Webex?.init({
      appName: 'openclaw-webex-auto-join',
      appPlatform: 'openclaw',
      credentials: { access_token: boot.accessToken },
    });
    if (!webex) throw new Error('Webex Meetings SDK is unavailable');
    stage = 'sdk_ready';
    await new Promise<void>((resolve, reject) => {
      webex.once('ready', resolve);
      webex.once('error', reject);
    });
    stage = 'device_registration';
    await webex.meetings.register();
    stage = 'meeting_lookup';
    meeting = await webex.meetings.create(boot.destination ?? boot.meetingId ?? boot.joinLink);
    meeting.on?.('meeting:self:left', () => {
      if (!leaving) event('ended').catch(() => undefined);
    });
    meeting.on?.('meeting:self:guestAdmitted', () => {
      waitingForAdmission = false;
      setStatus('Joined the Webex meeting.');
      event('joined').catch(() => undefined);
    });
    meeting.on?.('meeting:self:lobbyWaiting', () => {
      waitingForAdmission = true;
      setStatus('Waiting for the host to admit this Webex user.');
      event('waiting_for_admission').catch(() => undefined);
    });
    meeting.on?.('error', (error: unknown) => event('error', classify(error), diagnostic(error, 'meeting_event')).catch(() => undefined));
    if (meeting.passwordStatus === 'REQUIRED') {
      if (!boot.password) throw new Error('meeting password required');
      setStatus('Verifying the meeting password…');
      stage = 'password_verification';
      const result = await meeting.verifyPassword(boot.password);
      if (result?.requiredCaptcha) throw new Error('captcha required');
      if (!result?.isPasswordValid) throw new Error('meeting password rejected');
    }
    setStatus('Joining the Webex meeting without media…');
    stage = 'meeting_join';
    await noMediaAdapter.join(meeting);
    webex.meetings.on?.('meeting:removed', (removed: any) => {
      if (!leaving && (!removed?.id || removed.id === meeting?.id)) event('ended').catch(() => undefined);
    });
    if (!waitingForAdmission) {
      stage = 'joined';
      setStatus('Joined the Webex meeting.');
      await event('joined');
    }
    setInterval(() => event('heartbeat').catch(() => undefined), 15_000);
    setInterval(checkControl, 1000);
  } catch (error) {
    const code = classify(error);
    setStatus(`Could not join the Webex meeting (${code}).`);
    await event('error', code, diagnostic(error)).catch(() => undefined);
  }
}

async function checkControl() {
  if (leaving) return;
  try {
    const control = await request('control');
    if (!control.leave) return;
    leaving = true;
    await meeting?.leave?.();
    await event('left');
  } catch {
    // The gateway will close a stale runner after its leave timeout.
  }
}

document.querySelector('#join-meeting')?.addEventListener('click', () => start());
if (document.body?.dataset?.autostart === 'true') queueMicrotask(() => start());
