// Stub for `node-jose`, aliased in for browser bundling only (see
// browser-runtime.js's esbuild `alias` option).
//
// `node-jose` is only reachable because @webex/internal-plugin-conversation
// unconditionally `require()`s @webex/internal-plugin-encryption at
// module-load time (an undeclared runtime coupling — not listed in
// conversation's own package.json dependencies, found by grepping its dist
// output), which in turn requires node-jose. node-jose's own
// lib/algorithms/ecdsa.js calls `helpers.nodeCrypto.getHashes()` — a
// Node-only crypto API with no Web Crypto equivalent — at the top of the
// module, before exporting anything, which throws immediately in a real
// browser page.
//
// We never exercise KMS/message-content encryption in this plugin (meeting
// join/leave doesn't touch Teams-space message content, which is the only
// thing internal-plugin-encryption is for), so a stub that loads safely and
// throws only if something genuinely tries to *use* JOSE crypto is
// preferable to trying to make node-jose's Node-oriented internals
// browser-compatible. A Proxy that lazily throws on any actual method call
// (rather than a hand-picked set of exports) means this doesn't need to
// track node-jose's exact API surface — if that assumption ever turns out
// to be wrong, it fails loudly here instead of silently misbehaving.
'use strict';

function throwingFn(path) {
  return function stub() {
    throw new Error(
      `webex-meeting-join: node-jose is stubbed out for browser bundling (JOSE/KMS crypto is not used by this plugin's meeting join/leave flow) — attempted to call ${path}()`
    );
  };
}

function makeStub(path) {
  const target = throwingFn(path);
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'then') return undefined; // never mistaken for a thenable
      return makeStub(`${path}.${String(prop)}`);
    },
  });
}

module.exports = makeStub('node-jose');
