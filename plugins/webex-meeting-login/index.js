'use strict';

const WEBEX_SIGN_IN_URL = 'https://web.webex.com/sign-in/enter-email';
const EMAIL_ENV = 'MEETING_JOIN_EXPECTED_EMAIL';
const PASSWORD_ENV = 'MEETING_JOIN_WEB_PASSWORD';
const SESSION_KEY = 'agent:main:webex-meeting-login:startup';

function buildLoginPrompt(email, password) {
  return `You are performing the dedicated meeting agent's one permitted startup task: sign in to Webex.

Use only the browser tool, with every browser call explicitly targeting the gateway-managed Brave browser (target="host", profile="openclaw"). Do not use exec, web search, web fetch, messaging, or any other tool. Do not visit any URL other than ${WEBEX_SIGN_IN_URL}.

1. Navigate to ${WEBEX_SIGN_IN_URL}.
2. Inspect the page and enter this email in the email field: ${email}
3. Press the Sign In button.
4. Wait for the password field, enter this password: ${password}
5. Press the Log in button and wait until Webex confirms the signed-in state.

If the browser is already signed in, leave the existing signed-in session untouched and treat it as success. If Webex displays MFA, CAPTCHA, a security challenge, or a login error, stop immediately and do not attempt any alternate flow. Do not join, schedule, or interact with meetings.

Your final response must be exactly WEBEX_SIGN_IN_CONFIRMED after Webex confirms the signed-in state. Otherwise, respond exactly WEBEX_SIGN_IN_BLOCKED. Never include the email address or password in your final response.`;
}

function getCredentials(env = process.env) {
  const email = env[EMAIL_ENV]?.trim();
  const password = env[PASSWORD_ENV];
  if (!email || !password) {
    throw new Error(`missing ${!email ? EMAIL_ENV : PASSWORD_ENV}`);
  }
  return { email, password };
}

async function dispatchLogin(runtime, prompt) {
  const dispatch = runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) throw new Error('OpenClaw agent pipeline dispatch unavailable');

  const cfg = runtime.config?.current?.() ?? {};
  const now = new Date().toISOString();
  let dispatchError = null;
  const replies = [];
  await dispatch({
    ctx: {
      Body: prompt,
      RawBody: prompt,
      CommandBody: prompt,
      From: 'webex-meeting-login',
      To: 'webex-meeting-login',
      SessionKey: SESSION_KEY,
      AccountId: 'default',
      ChatType: 'direct',
      SenderName: 'Webex Meeting Login',
      SenderId: 'webex-meeting-login',
      Provider: 'webex-meeting-login',
      Surface: 'webex-meeting-login',
      MessageSid: `webex-meeting-login:${Date.now()}`,
      Timestamp: now,
      OriginatingChannel: 'webex-meeting-login',
      OriginatingTo: 'webex-meeting-login',
      IsMentioned: true
    },
    cfg,
    dispatcherOptions: {
      // This is a background startup task. Its text is discarded so login
      // details and page state are never delivered to a channel.
      deliver: async (out) => {
        const text = out?.text || out?.markdown;
        if (text) replies.push(String(text));
      },
      onError: (err) => { dispatchError = err instanceof Error ? err : new Error(String(err)); }
    },
    replyOptions: {}
  });

  if (dispatchError) throw dispatchError;
  return replies.join('\n').trim();
}

function assertSignInConfirmed(agentReply) {
  if (agentReply === 'WEBEX_SIGN_IN_CONFIRMED') return;
  throw new Error(
    agentReply === 'WEBEX_SIGN_IN_BLOCKED'
      ? 'Webex sign-in was blocked by the page'
      : 'agent did not confirm Webex sign-in'
  );
}

function register(api) {
  api.on('gateway_start', async () => {
    try {
      const { email, password } = getCredentials();
      api.logger?.info?.('[webex-meeting-login] agent sign-in attempt started');
      const reply = await dispatchLogin(api.runtime, buildLoginPrompt(email, password));
      assertSignInConfirmed(reply);
      api.logger?.info?.('[webex-meeting-login] agent has signed in to Webex');
    } catch (err) {
      api.logger?.error?.(`[webex-meeting-login] agent sign-in failed: ${err?.message ?? err}`);
    }
  }, { timeoutMs: 120000 });
}

module.exports = register;
module.exports.default = register;
module.exports.buildLoginPrompt = buildLoginPrompt;
module.exports.getCredentials = getCredentials;
module.exports.dispatchLogin = dispatchLogin;
module.exports.assertSignInConfirmed = assertSignInConfirmed;
module.exports.WEBEX_SIGN_IN_URL = WEBEX_SIGN_IN_URL;
