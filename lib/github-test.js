// github-lib-test.js — manual test for lib/github.js
//
// Run with GitHub App credentials passed as environment variables:
//
//   GITHUB_APP_ID=<app_id> \
//   GITHUB_APP_PRIVATE_KEY="$(cat secrets/<private-key>.pem)" \
//   node github-lib-test.js
//
// Update owner/repo/path below to match your test repository.

import { readFile, writeFile } from './github.js';

// Test write
await writeFile(
  'msc-project-2026',
  'web-app-test',
  '.collab/test.md',
  '# Test\nHello',
  'test: verify github module'
);

// Rest read
const content = await readFile(
  'msc-project-2026',
  'web-app-test',
  '.collab/test.md'
);
console.log(content);
