'use strict';

// Copies the prebuilt Webex SDK UMD bundle (webex.min.js) out of
// node_modules into this plugin's own directory, so meeting-client.html can
// load it via a plain <script> tag without esbuild ever trying to bundle
// the SDK's source (which pulls in Node built-ins — see client.js's header
// comment for why that approach was abandoned).
//
// Uses require.resolve rather than a hardcoded relative path because npm
// workspaces may hoist `webex` to the repo root's node_modules instead of
// plugins/webex/node_modules, depending on dependency resolution — this
// works either way.

const fs = require('node:fs');
const path = require('node:path');

const src = require.resolve('webex/umd/webex.min.js');
const dest = path.join(__dirname, 'webex-sdk.min.js');

fs.copyFileSync(src, dest);
console.log(`Copied Webex SDK bundle: ${src} -> ${dest}`);
