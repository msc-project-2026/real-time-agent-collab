'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const dns = require('node:dns/promises');
const { chromium } = require('playwright');

const browserPath = require.resolve('./browser.js');

function makeDocument() {
  const anchors = [
    { href: 'https://public.example/ok', textContent: 'Working link', getAttribute: () => '/ok' },
    { href: 'https://public.example/missing', textContent: 'Missing link', getAttribute: () => '/missing' },
    { href: 'https://public.example/missing', textContent: 'Duplicate', getAttribute: () => '/missing' },
    { href: 'https://other.example/', textContent: 'External link', getAttribute: () => 'https://other.example/' },
    { href: '', textContent: 'No target', getAttribute: () => null },
  ];
  const image = { src: 'https://public.example/logo.png', alt: '', complete: true, naturalWidth: 0 };
  const heading = { tagName: 'H2', textContent: '  Browser report  ' };
  const input = { type: 'email', name: 'email', id: 'email', tagName: 'INPUT' };
  const form = {
    action: 'https://public.example/subscribe', method: 'post',
    querySelectorAll: () => [input],
  };
  const button = { textContent: '', value: 'Send', type: 'submit', disabled: false, getAttribute: (key) => key === 'aria-label' ? 'Send form' : null, title: '' };
  const script = { src: 'https://public.example/app.js' };
  const stylesheet = { href: 'https://public.example/site.css' };
  return {
    querySelectorAll(selector) {
      return {
        a: anchors,
        img: [image],
        'h1,h2,h3,h4,h5,h6': [heading],
        form: [form],
        'button,[role="button"],input[type="submit"]': [button],
        'input,select,textarea': [input],
        'script[src]': [script],
        'link[rel="stylesheet"]': [stylesheet],
      }[selector] ?? [];
    },
    querySelector(selector) { return selector === 'label[for="email"]' ? { textContent: 'Email' } : null; },
  };
}

function installBrowserFakes(t) {
  const originalLookup = dns.lookup;
  const originalLaunch = chromium.launch;
  const originalSetTimeout = global.setTimeout;
  const originalDocument = global.document;
  const originalWindow = global.window;
  const originalLocation = global.location;
  const launches = [];
  const contexts = [];

  global.document = makeDocument();
  global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  global.location = { origin: 'https://public.example' };
  global.setTimeout = () => ({ unref() {} });
  dns.lookup = async () => [{ address: '203.0.113.50', family: 4 }];
  chromium.launch = async (options) => {
    launches.push(options);
    return {
      isConnected: () => true,
      newContext: async (options = {}) => {
        const events = {};
        const context = {
          options,
          closed: false,
          request: {
            head: async (href) => {
              if (href.endsWith('/missing')) return { status: () => 404 };
              if (href.endsWith('/ok')) return { status: () => 200 };
              throw new Error('HEAD request failed');
            },
          },
          newPage: async () => ({
            on: (event, callback) => { events[event] = callback; },
            goto: async () => {
              events.console?.({ type: () => 'error', text: () => 'uncaught test error' });
              events.response?.({ status: () => 503, url: () => 'https://public.example/api' });
              events.requestfailed?.({ url: () => 'https://public.example/font.woff2', failure: () => ({ errorText: 'net::ERR_FAILED' }) });
            },
            title: async () => 'Test page',
            evaluate: async (callback) => callback({
              tagName: 'BUTTON',
              attributes: [{ name: 'id', value: 'submit' }, { name: 'data-state', value: 'ready' }],
              textContent: '  Submit  ',
              getBoundingClientRect: () => ({ x: 4, y: 8, width: 120, height: 30 }),
            }),
            screenshot: async () => Buffer.from('png-data'),
            locator: (selector) => ({
              first: () => ({
                count: async () => selector === '.missing' ? 0 : 1,
                evaluate: async (callback) => callback({
                  tagName: 'BUTTON',
                  attributes: [{ name: 'id', value: 'submit' }, { name: 'data-state', value: 'ready' }],
                  textContent: '  Submit  ',
                  getBoundingClientRect: () => ({ x: 4, y: 8, width: 120, height: 30 }),
                }),
              }),
            }),
            context: () => context,
          }),
          close: async () => { context.closed = true; },
        };
        contexts.push(context);
        return context;
      },
      close: async () => {},
    };
  };
  delete require.cache[browserPath];
  t.after(() => {
    dns.lookup = originalLookup;
    chromium.launch = originalLaunch;
    global.setTimeout = originalSetTimeout;
    global.document = originalDocument;
    global.window = originalWindow;
    global.location = originalLocation;
    delete require.cache[browserPath];
  });
  return { ...require('./browser.js'), launches, contexts };
}

test('blocks unsafe navigation before a browser session is created', async (t) => {
  const { inspectPage, launches } = installBrowserFakes(t);

  await assert.rejects(inspectPage('ftp://public.example/file'), /Blocked protocol/);
  await assert.rejects(inspectPage('http://127.0.0.1/admin'), /private IP/);
  await assert.rejects(inspectPage('http://localhost/admin'), /localhost/);
  assert.equal(launches.length, 0);
});

test('blocks hostnames that resolve to private infrastructure', async (t) => {
  const { inspectPage, launches } = installBrowserFakes(t);
  dns.lookup = async () => [{ address: '10.2.3.4', family: 4 }, { address: '2001:db8::10', family: 6 }];

  await assert.rejects(inspectPage('https://internal-looking.example/'), /resolves to private IP 10\.2\.3\.4/);
  assert.equal(launches.length, 0);
});

test('inspects a page, deduplicates internal link checks, and closes its context', async (t) => {
  const { inspectPage, launches, contexts } = installBrowserFakes(t);

  const report = await inspectPage('https://public.example/start', { checkLinks: true, timeout: 1234 });

  assert.equal(report.title, 'Test page');
  assert.deepEqual(report.consoleErrors, ['uncaught test error']);
  assert.deepEqual(report.brokenResources, [{ url: 'https://public.example/api', status: 503 }]);
  assert.deepEqual(report.failedRequests, [{ url: 'https://public.example/font.woff2', error: 'net::ERR_FAILED' }]);
  assert.deepEqual(report.brokenLinks, [{ url: 'https://public.example/missing', status: 404 }]);
  assert.equal(report.analysis.images[0].missingAlt, true);
  assert.equal(report.analysis.images[0].loaded, false);
  assert.equal(report.analysis.forms[0].inputs[0].hasLabel, true);
  assert.equal(report.analysis.buttons[0].hasAccessibleName, true);
  assert.equal(launches.length, 1);
  assert.equal(contexts[0].closed, true);
});

test('captures screenshots, reports element details, and returns page structure', async (t) => {
  const { screenshotPage, inspectElement, getPageStructure, contexts } = installBrowserFakes(t);

  const shot = await screenshotPage('https://public.example/start', { fullPage: true, width: 900, height: 600 });
  assert.deepEqual(shot, { base64: Buffer.from('png-data').toString('base64'), mimeType: 'image/png' });
  assert.deepEqual(contexts[0].options, { viewport: { width: 900, height: 600 } });

  const found = await inspectElement('https://public.example/start', '#submit');
  assert.deepEqual(found, {
    found: true, selector: '#submit', tag: 'button', attributes: { id: 'submit', 'data-state': 'ready' },
    textContent: 'Submit', boundingBox: { x: 4, y: 8, width: 120, height: 30 }, visible: true,
  });
  assert.deepEqual(await inspectElement('https://public.example/start', '.missing'), { found: false, selector: '.missing' });

  const structure = await getPageStructure('https://public.example/start');
  assert.equal(structure.headings[0].level, 2);
  assert.equal(structure.links[0].isExternal, false);
  assert.equal(structure.links[3].isExternal, true);
  assert.equal(structure.forms[0].fieldCount, 1);
  assert.deepEqual(structure.scripts, ['https://public.example/app.js']);
  assert.deepEqual(structure.stylesheets, ['https://public.example/site.css']);
  assert.ok(contexts.every((context) => context.closed));
});
