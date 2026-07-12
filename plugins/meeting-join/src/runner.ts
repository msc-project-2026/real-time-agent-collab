declare global {
  interface Window { meetingJoinStarted?: boolean; Webex?: any }
}

const base = window.location.pathname.replace(/\/$/, '');
let meeting: any;
let leaving = false;
let waitingForAdmission = false;

function setStatus(message: string) {
  const status = document.querySelector<HTMLElement>('#meeting-status');
  if (status) status.textContent = message;
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}/${path}`, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error(`Runner request failed (${response.status})`);
  return response.json();
}

async function event(type: string, code?: string) {
  await request('events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...(code ? { code } : {}) }),
  });
}

function classify(error: unknown) {
  const message = String((error as any)?.message ?? error ?? '').toLowerCase();
  if (message.includes('captcha')) return 'captcha_required';
  if (message.includes('password')) return 'meeting_password_rejected';
  return 'meeting_join_failed';
}

async function start() {
  if (window.meetingJoinStarted) return;
  window.meetingJoinStarted = true;
  const joinButton = document.querySelector<HTMLButtonElement>('#join-meeting');
  if (joinButton) joinButton.disabled = true;
  setStatus('Connecting to Webex…');
  try {
    const boot = await request('bootstrap');
    await event('joining');
    setStatus('Authenticating the configured Webex user…');
    const webex: any = window.Webex?.init({
      appName: 'openclaw-meeting-join',
      appPlatform: 'openclaw',
      credentials: { access_token: boot.accessToken },
    });
    if (!webex) throw new Error('Webex Meetings SDK is unavailable');
    await new Promise<void>((resolve, reject) => {
      webex.once('ready', resolve);
      webex.once('error', reject);
    });
    await webex.meetings.register();
    meeting = await webex.meetings.create(boot.joinLink);
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
    meeting.on?.('error', (error: unknown) => event('error', classify(error)).catch(() => undefined));
    if (meeting.passwordStatus === 'REQUIRED') {
      setStatus('Verifying the meeting password…');
      const result = await meeting.verifyPassword(boot.password);
      if (result?.requiredCaptcha) throw new Error('captcha required');
      if (!result?.isPasswordValid) throw new Error('meeting password rejected');
    }
    setStatus('Joining the Webex meeting without media…');
    await meeting.join(); // Phase 1 intentionally joins without media.
    if (!waitingForAdmission) {
      setStatus('Joined the Webex meeting.');
      await event('joined');
    }
    setInterval(() => event('heartbeat').catch(() => undefined), 15_000);
    setInterval(checkControl, 1000);
  } catch (error) {
    const code = classify(error);
    setStatus(`Could not join the Webex meeting (${code}).`);
    await event('error', code).catch(() => undefined);
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
