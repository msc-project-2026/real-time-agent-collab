'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const indexPath = require.resolve('./index.js');
const browserPath = require.resolve('./browser.js');
const cachePath = require.resolve('../../lib/collab-cache.js');

function loadPlugin(t, cache = {}) {
  const previous = new Map([[browserPath, require.cache[browserPath]], [cachePath, require.cache[cachePath]]]);
  const browserCalls = [];
  require.cache[browserPath] = {
    id: browserPath, filename: browserPath, loaded: true,
    exports: {
      inspectPage: async (...args) => { browserCalls.push(['inspectPage', ...args]); return { inspected: true }; },
      screenshotPage: async (...args) => { browserCalls.push(['screenshotPage', ...args]); return { base64: Buffer.from('image').toString('base64'), mimeType: 'image/png' }; },
      inspectElement: async (...args) => { browserCalls.push(['inspectElement', ...args]); return { found: true }; },
      getPageStructure: async (...args) => { browserCalls.push(['getPageStructure', ...args]); return { headings: [] }; },
    },
  };
  require.cache[cachePath] = { id: cachePath, filename: cachePath, loaded: true, exports: cache };
  delete require.cache[indexPath];
  const register = require('./index.js');
  t.after(() => {
    delete require.cache[indexPath];
    for (const [path, entry] of previous) {
      if (entry) require.cache[path] = entry;
      else delete require.cache[path];
    }
  });
  return { register, browserCalls };
}

function toolsFor(register) {
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, tool) });
  return tools;
}

test('registers the browser inspection tools and forwards their option shapes', async (t) => {
  const { register, browserCalls } = loadPlugin(t, {
    saveIssue: async () => ({ id: 'ISSUE-7' }),
    readSourceFile: async () => 'const current = true;',
    saveSuggestion: async () => ({ id: 'FIX-9', filePath: 'src/App.js', explanation: 'Corrects the selector.' }),
    commitSuggestion: async () => ({ sha: 'abc123' }),
    updateSuggestionStatus: async () => {},
  });
  const tools = toolsFor(register);

  assert.equal(tools.size, 9);
  assert.equal(register.id, 'browser-inspector');
  assert.equal(register.default, register);
  assert.deepEqual(await tools.get('inspect_webpage').handler({ url: 'https://example.test', check_links: true }), { inspected: true });
  assert.deepEqual(await tools.get('inspect_element').handler({ url: 'https://example.test', selector: '#app' }), { found: true });
  assert.deepEqual(await tools.get('get_page_structure').handler({ url: 'https://example.test' }), { headings: [] });
  assert.deepEqual(browserCalls, [
    ['inspectPage', 'https://example.test', { checkLinks: true }],
    ['inspectElement', 'https://example.test', '#app'],
    ['getPageStructure', 'https://example.test'],
  ]);
  assert.deepEqual(await tools.get('log_browser_issue').handler({ room_id: 'room', title: 'Broken link', severity: 'high', description: '404' }), { ok: true, id: 'ISSUE-7' });
  assert.deepEqual(await tools.get('read_source_file').handler({ room_id: 'room', file_path: 'src/App.js' }), { found: true, file_path: 'src/App.js', content: 'const current = true;' });
  assert.deepEqual(await tools.get('suggest_fix').handler({ room_id: 'room', file_path: 'src/App.js', proposed_content: 'fixed', explanation: 'Corrects the selector.' }), { ok: true, id: 'FIX-9', filePath: 'src/App.js', explanation: 'Corrects the selector.' });
  assert.deepEqual(await tools.get('commit_fix').handler({ room_id: 'room', suggestion_id: 'FIX-9' }), { ok: true, sha: 'abc123' });
  assert.deepEqual(await tools.get('reject_fix').handler({ room_id: 'room', suggestion_id: 'FIX-9' }), { ok: true, id: 'FIX-9' });
});

test('screenshot upload requires a token and surfaces a rejected Webex response', async (t) => {
  const { register, browserCalls } = loadPlugin(t);
  const screenshot = toolsFor(register).get('screenshot_page');
  const originalToken = process.env.WEBEX_BOT_TOKEN;
  const originalFetch = global.fetch;
  t.after(() => {
    if (originalToken === undefined) delete process.env.WEBEX_BOT_TOKEN;
    else process.env.WEBEX_BOT_TOKEN = originalToken;
    global.fetch = originalFetch;
  });
  delete process.env.WEBEX_BOT_TOKEN;
  assert.deepEqual(await screenshot.handler({ url: 'https://example.test', room_id: 'room' }), { ok: false, error: 'WEBEX_BOT_TOKEN not set — cannot post screenshot' });

  process.env.WEBEX_BOT_TOKEN = 'token';
  global.fetch = async () => ({ ok: false, status: 413, text: async () => 'payload too large' });
  assert.deepEqual(await screenshot.handler({ url: 'https://example.test', room_id: 'room', full_page: true, viewport_width: 640, viewport_height: 480 }), { ok: false, error: 'Webex upload failed: 413 payload too large' });
  assert.deepEqual(browserCalls, [
    ['screenshotPage', 'https://example.test', { fullPage: undefined, width: undefined, height: undefined }],
    ['screenshotPage', 'https://example.test', { fullPage: true, width: 640, height: 480 }],
  ]);
});

test('storage-backed tools report disabled integrations and handler errors clearly', async (t) => {
  const { register } = loadPlugin(t, {
    commitSuggestion: async () => { throw new Error('not approved'); },
    updateSuggestionStatus: async () => { throw new Error('missing suggestion'); },
    readSourceFile: async () => null,
  });
  const tools = toolsFor(register);

  assert.deepEqual(await tools.get('log_browser_issue').handler({}), { ok: false, error: 'collab-cache module not available — issues.md logging is disabled' });
  assert.deepEqual(await tools.get('read_source_file').handler({ room_id: 'room', file_path: 'missing.js' }), { found: false, file_path: 'missing.js' });
  assert.deepEqual(await tools.get('suggest_fix').handler({}), { ok: false, error: 'collab-cache module not available, fix suggestions are disabled' });
  assert.deepEqual(await tools.get('commit_fix').handler({ room_id: 'room', suggestion_id: 'FIX-404' }), { ok: false, error: 'not approved' });
  assert.deepEqual(await tools.get('reject_fix').handler({ room_id: 'room', suggestion_id: 'FIX-404' }), { ok: false, error: 'missing suggestion' });
});
