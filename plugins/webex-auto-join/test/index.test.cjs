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
    'webex_auto_join_status',
  ]);
});

test('read-only discovery exposes capabilities without constructing the service', async () => {
  const { register } = await import('../dist/index.js');
  const tools = [];
  const routes = [];
  const hooks = [];
  const api = {
    registrationMode: 'discovery',
    registerTool(tool) { tools.push(tool.name); },
    registerHttpRoute(route) { routes.push(route.path); },
    on(name) { hooks.push(name); },
  };

  register(api);
  assert.equal(tools.length, 5);
  assert.deepEqual(routes, ['/webhooks/webex-auto-join', '/webex-auto-join/runner/']);
  assert.deepEqual(hooks, ['gateway_start', 'gateway_stop']);
});

test('full runtime and tool execution resolve the same process-wide service', async () => {
  const key = Symbol.for('openclaw.webex-auto-join.service');
  delete globalThis[key];
  const { getSharedService } = await import('../dist/index.js');
  const first = getSharedService({ runtime: { id: 'full' }, pluginConfig: {}, logger: console });
  const second = getSharedService({ runtime: { id: 'tool-discovery' }, pluginConfig: {}, logger: console });

  assert.equal(first, second);
  delete globalThis[key];
});

test('full registration owns the fixed webhook and runner routes plus gateway lifecycle', async () => {
  const key = Symbol.for('openclaw.webex-auto-join.service');
  delete globalThis[key];
  const { register } = await import('../dist/index.js');
  const routes = [];
  const hooks = [];
  const tools = [];
  register({
    registrationMode: 'full',
    runtime: {},
    pluginConfig: {},
    logger: { warn() {}, info() {} },
    registerTool(tool) { tools.push(tool.name); },
    registerHttpRoute(route) { routes.push({ path: route.path, auth: route.auth, match: route.match }); },
    on(name) { hooks.push(name); },
  });

  assert.deepEqual(routes, [
    { path: '/webhooks/webex-auto-join', auth: 'plugin', match: 'exact' },
    { path: '/webex-auto-join/runner/', auth: 'plugin', match: 'prefix' },
  ]);
  assert.deepEqual(hooks, ['gateway_start', 'gateway_stop']);
  assert.ok(tools.includes('webex_auto_join_status'));
  delete globalThis[key];
});
