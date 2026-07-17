'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WEBEX_SIGN_IN_URL, buildLoginPrompt, dispatchLogin, getCredentials } = require('./index');

test('buildLoginPrompt is limited to the Webex sign-in workflow', () => {
  const prompt = buildLoginPrompt('agent@example.test', 'password-value');
  assert.ok(prompt.includes(WEBEX_SIGN_IN_URL));
  assert.match(prompt, /Use only the browser tool/);
  assert.match(prompt, /Do not join, schedule, or interact with meetings/);
  assert.match(prompt, /password-value/);
});

test('getCredentials rejects an incomplete environment', () => {
  assert.throws(
    () => getCredentials({ MEETING_JOIN_EXPECTED_EMAIL: 'agent@example.test' }),
    /MEETING_JOIN_WEB_PASSWORD/
  );
});

test('dispatchLogin routes the prompt to the main agent startup session', async () => {
  let dispatched;
  const runtime = {
    config: { current: () => ({ configured: true }) },
    channel: { reply: { dispatchReplyWithBufferedBlockDispatcher: async (request) => { dispatched = request; } } }
  };

  await dispatchLogin(runtime, 'sign in');
  assert.equal(dispatched.ctx.SessionKey, 'agent:main:webex-meeting-login:startup');
  assert.equal(dispatched.ctx.Body, 'sign in');
  assert.deepEqual(dispatched.cfg, { configured: true });
  await dispatched.dispatcherOptions.deliver({ text: 'intentionally discarded' });
});
