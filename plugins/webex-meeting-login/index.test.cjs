'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WEBEX_SIGN_IN_URL,
  assertSignInConfirmed,
  buildLoginPrompt,
  dispatchLogin,
  getCredentials
} = require('./index');

test('buildLoginPrompt is limited to the Webex sign-in workflow', () => {
  const prompt = buildLoginPrompt('agent@example.test', 'password-value');
  assert.ok(prompt.includes(WEBEX_SIGN_IN_URL));
  assert.match(prompt, /target="host", profile="openclaw"/);
  assert.match(prompt, /Do not join, schedule, or interact with meetings/);
  assert.match(prompt, /WEBEX_SIGN_IN_CONFIRMED/);
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
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (request) => {
          dispatched = request;
          await request.dispatcherOptions.deliver({ text: 'WEBEX_SIGN_IN_CONFIRMED' });
        }
      }
    }
  };

  const reply = await dispatchLogin(runtime, 'sign in');
  assert.equal(dispatched.ctx.SessionKey, 'agent:main:webex-meeting-login:startup');
  assert.equal(dispatched.ctx.Body, 'sign in');
  assert.deepEqual(dispatched.cfg, { configured: true });
  assert.equal(reply, 'WEBEX_SIGN_IN_CONFIRMED');
});

test('dispatchLogin propagates dispatcher failures', async () => {
  const runtime = {
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (request) => {
          request.dispatcherOptions.onError(new Error('Sandbox image not found'));
        }
      }
    }
  };

  await assert.rejects(() => dispatchLogin(runtime, 'sign in'), /Sandbox image not found/);
});

test('assertSignInConfirmed accepts only the explicit confirmation', () => {
  assert.doesNotThrow(() => assertSignInConfirmed('WEBEX_SIGN_IN_CONFIRMED'));
  assert.throws(() => assertSignInConfirmed('WEBEX_SIGN_IN_BLOCKED'), /blocked/);
  assert.throws(() => assertSignInConfirmed('looks signed in'), /did not confirm/);
});
