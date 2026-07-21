// Stub for the `jsonwebtoken` package, aliased in for browser bundling only
// (see browser-runtime.js's esbuild `alias` option).
//
// Real `jsonwebtoken` pulls in `jws`, whose `data-stream.js`/`sign-stream.js`
// call `util.inherits(Ctor, Stream)` against the `stream` polyfill provided
// by esbuild-plugin-polyfill-node — that polyfill's `Stream` export isn't a
// constructor `util.inherits` accepts, which throws "Object prototype may
// only be an Object or null: undefined" at bundle-evaluation time, before
// any of our own code runs. Found by loading the real bundle in headless
// Chromium, not from the docs.
//
// It's only pulled in by @webex/webex-core's credentials.js and the
// authorization-{browser,node} plugins — none of which we exercise: this
// plugin authenticates with a plain OAuth access_token (opaque, not a JWT)
// via Webex.init({ credentials: { access_token } }), and never calls
// webex.authorization.*. Where credentials.js calls jwt.decode() on our
// token, real jsonwebtoken would also just return null for a non-JWT string
// (decode() doesn't throw on invalid input) — so this stub matches real
// behavior for our flow rather than merely papering over the crash.
'use strict';

function decode() {
  return null;
}

function sign() {
  throw new Error('webex-meeting-join: jsonwebtoken.sign is stubbed out for browser bundling (JWT/guest auth is not used by this plugin)');
}

function verify() {
  throw new Error('webex-meeting-join: jsonwebtoken.verify is stubbed out for browser bundling (JWT/guest auth is not used by this plugin)');
}

module.exports = { decode, sign, verify };
module.exports.default = module.exports;
