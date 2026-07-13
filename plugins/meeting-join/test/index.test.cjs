'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('tool discovery registers tools without routes, hooks, or service startup', async () => {
  const { register } = await import('../dist/index.js');
  const tools = [];
  const api = {
    registrationMode: 'tool-discovery',
    registerTool(tool) { tools.push(tool.name); },
    registerHttpRoute() { assert.fail('tool discovery registered an HTTP route'); },
    on() { assert.fail('tool discovery registered a lifecycle hook'); },
  };

  register(api);
  assert.deepEqual(tools, [
    'join_webex_meeting',
    'leave_webex_meeting',
    'inspect_webex_meeting_runner',
    'act_webex_meeting_runner',
  ]);
});

test('non-runtime discovery does not register active meeting surfaces', async () => {
  const { register } = await import('../dist/index.js');
  let registrations = 0;
  const api = {
    registrationMode: 'discovery',
    registerTool() { registrations += 1; },
    registerHttpRoute() { registrations += 1; },
    on() { registrations += 1; },
  };

  register(api);
  assert.equal(registrations, 0);
});

test('full runtime and tool execution resolve the same process-wide service', async () => {
  const key = Symbol.for('openclaw.meeting-join.service');
  delete globalThis[key];
  const { getSharedService } = await import('../dist/index.js');
  const first = getSharedService({ runtime: { id: 'full' }, pluginConfig: {}, logger: console });
  const second = getSharedService({ runtime: { id: 'tool-discovery' }, pluginConfig: {}, logger: console });

  assert.equal(first, second);
  delete globalThis[key];
});
