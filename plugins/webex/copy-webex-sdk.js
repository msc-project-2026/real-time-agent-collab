'use strict';

// Copies the prebuilt Webex SDK UMD bundle (webex.min.js) out of
// node_modules into this plugin's own directory, so meeting-client.html can
// load it via a plain <script> tag without esbuild ever trying to bundle
// the SDK's source (which pulls in Node built-ins — see client.js's header
// comment for why that approach was abandoned).
//
// IMPORTANT: this does NOT use require.resolve('webex/umd/webex.min.js').
// The webex package's package.json defines an "exports" map that doesn't
// whitelist that subpath, so require.resolve() refuses to resolve it
// (ERR_PACKAGE_PATH_NOT_EXPORTED) even though the file genuinely exists on
// disk. Instead, require.resolve.paths('webex') is used to find the
// candidate node_modules directories Node would search — that lookup is
// not subject to "exports" restrictions, since it's just locating
// directories, not resolving a module specifier — and then the file is
// read directly with fs, sidestepping module resolution for that last step
// entirely.

const fs = require('node:fs');
const path = require('node:path');

function findWebexPackageDir() {
  const searchPaths = require.resolve.paths('webex') || [];
  for (const dir of searchPaths) {
    const candidate = path.join(dir, 'webex');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  throw new Error(
    'Could not locate the "webex" package directory in any node_modules path. ' +
      'Searched: ' + searchPaths.join(', ')
  );
}

const webexDir = findWebexPackageDir();
const src = path.join(webexDir, 'umd', 'webex.min.js');
const dest = path.join(__dirname, 'webex-sdk.min.js');

if (!fs.existsSync(src)) {
  throw new Error(
    `Resolved the "webex" package at ${webexDir}, but expected UMD bundle ` +
      `wasn't found at ${src}. The path inside the package may have changed ` +
      `in this version — check node_modules/webex's actual contents.`
  );
}

fs.copyFileSync(src, dest);
console.log(`Copied Webex SDK bundle: ${src} -> ${dest}`);