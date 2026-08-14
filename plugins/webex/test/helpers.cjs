'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function loadWithMocks(subjectId, mocks = {}) {
  const resolvedSubject = require.resolve(subjectId);
  const savedEntries = new Map();

  const replaceCacheEntry = (id, exports) => {
    const resolved = require.resolve(id);
    savedEntries.set(resolved, require.cache[resolved]);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
      children: [],
      paths: [],
    };
  };

  savedEntries.set(resolvedSubject, require.cache[resolvedSubject]);
  delete require.cache[resolvedSubject];

  for (const [id, exports] of Object.entries(mocks)) {
    replaceCacheEntry(id, exports);
  }

  let subject;
  try {
    subject = require(resolvedSubject);
  } catch (err) {
    restore();
    throw err;
  }

  function restore() {
    for (const [id, entry] of savedEntries) {
      if (entry) require.cache[id] = entry;
      else delete require.cache[id];
    }
  }

  return { subject, restore };
}

async function makeTempWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webex-main-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function makeLog(t) {
  return {
    info: t.mock.fn(),
    warn: t.mock.fn(),
    error: t.mock.fn(),
    debug: t.mock.fn(),
  };
}

function mockCalls(fn) {
  return fn.mock.calls.map((call) => call.arguments);
}

module.exports = {
  loadWithMocks,
  makeLog,
  makeTempWorkspace,
  mockCalls,
};
