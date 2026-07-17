'use strict';

const { chromium } = require('playwright');
const { URL } = require('node:url');
const dns = require('node:dns/promises');
const net = require('node:net');

let _browser = null;
let _idleTimer = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;

const BLOCKED_RANGES = [
  { prefix: '127.', family: 4 },
  { prefix: '10.', family: 4 },
  { prefix: '192.168.', family: 4 },
  { prefix: '0.', family: 4 },
  { exact: '::1', family: 6 },
];

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    if (BLOCKED_RANGES.some((r) => r.family === 4 && r.prefix && ip.startsWith(r.prefix))) return true;
    const parts = ip.split('.').map(Number);
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1' || norm.startsWith('fe80') || norm.startsWith('fc') || norm.startsWith('fd')) return true;
    return false;
  }
  return false;
}

async function validateUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  if (hostname === 'localhost' || hostname === '[::1]') {
    throw new Error('Navigation to localhost is blocked');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error(`Navigation to private IP ${hostname} is blocked`);
    return;
  }
  const { address } = await dns.lookup(hostname, { family: 4 });
  if (isPrivateIP(address)) {
    throw new Error(`Hostname ${hostname} resolves to private IP ${address}`);
  }
}

async function getBrowser() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  _idleTimer = setTimeout(async () => {
    if (_browser) {
      await _browser.close().catch(() => {});
      _browser = null;
    }
  }, IDLE_TIMEOUT_MS);
  return _browser;
}

async function inspectPage(url, { checkLinks = false, timeout = NAV_TIMEOUT_MS } = {}) {
  await validateUrl(url);
  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const brokenResources = [];
    page.on('response', (response) => {
      if (response.status() >= 400) {
        brokenResources.push({ url: response.url(), status: response.status() });
      }
    });

    const failedRequests = [];
    page.on('requestfailed', (request) => {
      failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText,
      });
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout });

    const title = await page.title();

    const analysis = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).map((a) => ({
        href: a.href,
        text: a.textContent.trim().slice(0, 100),
        hasHref: !!a.getAttribute('href'),
      }));

      const images = Array.from(document.querySelectorAll('img')).map((img) => ({
        src: img.src,
        alt: img.alt,
        missingAlt: !img.alt,
        loaded: img.complete && img.naturalWidth > 0,
      }));

      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({
        level: parseInt(h.tagName[1], 10),
        text: h.textContent.trim().slice(0, 100),
      }));

      const forms = Array.from(document.querySelectorAll('form')).map((f) => ({
        action: f.action,
        method: f.method,
        inputs: Array.from(f.querySelectorAll('input,select,textarea')).map((i) => ({
          type: i.type || i.tagName.toLowerCase(),
          name: i.name,
          hasLabel: !!document.querySelector(`label[for="${i.id}"]`),
        })),
      }));

      const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).map((b) => ({
        text: b.textContent.trim().slice(0, 100) || b.value || '',
        type: b.type || 'button',
        disabled: b.disabled,
        hasAccessibleName: !!(b.textContent.trim() || b.getAttribute('aria-label') || b.title),
      }));

      return { links, images, headings, forms, buttons };
    });

    let brokenLinks = [];
    if (checkLinks) {
      const seen = new Set();
      const internalLinks = analysis.links
        .filter((l) => l.hasHref && l.href)
        .map((l) => l.href)
        .filter((href) => {
          if (seen.has(href)) return false;
          seen.add(href);
          try {
            const target = new URL(href);
            const origin = new URL(url);
            return target.origin === origin.origin;
          } catch {
            return false;
          }
        });

      const results = await Promise.allSettled(
        internalLinks.slice(0, 50).map(async (href) => {
          const res = await page.context().request.head(href, { timeout: 10_000 });
          return { url: href, status: res.status() };
        })
      );

      brokenLinks = results
        .filter((r) => r.status === 'fulfilled' && r.value.status >= 400)
        .map((r) => r.value);

      const failedLinks = results
        .filter((r) => r.status === 'rejected')
        .map((r) => ({ url: 'unknown', error: r.reason?.message }));

      brokenLinks.push(...failedLinks);
    }

    const hasIssues =
      consoleErrors.length > 0 ||
      brokenResources.length > 0 ||
      failedRequests.length > 0 ||
      brokenLinks.length > 0;

    let screenshot = null;
    if (hasIssues) {
      const buffer = await page.screenshot({ fullPage: false });
      screenshot = { base64: buffer.toString('base64'), mimeType: 'image/png' };
    }

    return {
      title,
      url,
      consoleErrors,
      brokenResources,
      failedRequests,
      brokenLinks,
      analysis,
      screenshot,
    };
  } finally {
    await context.close();
  }
}

async function screenshotPage(url, { fullPage = false, width = 1280, height = 720, timeout = NAV_TIMEOUT_MS } = {}) {
  await validateUrl(url);
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width, height } });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout });
    const buffer = await page.screenshot({ fullPage });
    return { base64: buffer.toString('base64'), mimeType: 'image/png' };
  } finally {
    await context.close();
  }
}

async function inspectElement(url, selector, { timeout = NAV_TIMEOUT_MS } = {}) {
  await validateUrl(url);
  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout });

    const handle = await page.$(selector);
    if (!handle) return { found: false, selector };

    const info = await handle.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      return {
        tag: el.tagName.toLowerCase(),
        attributes: attrs,
        textContent: el.textContent.trim().slice(0, 500),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      };
    });

    return { found: true, selector, ...info };
  } finally {
    await context.close();
  }
}

async function getPageStructure(url, { timeout = NAV_TIMEOUT_MS } = {}) {
  await validateUrl(url);
  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout });

    return page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({
        level: parseInt(h.tagName[1], 10),
        text: h.textContent.trim().slice(0, 100),
      }));

      const links = Array.from(document.querySelectorAll('a')).map((a) => ({
        href: a.href,
        text: a.textContent.trim().slice(0, 100),
        isExternal: (() => {
          try { return new URL(a.href).origin !== location.origin; } catch { return false; }
        })(),
      }));

      const images = Array.from(document.querySelectorAll('img')).map((img) => ({
        src: img.src,
        alt: img.alt,
        missingAlt: !img.alt,
        loaded: img.complete && img.naturalWidth > 0,
      }));

      const forms = Array.from(document.querySelectorAll('form')).map((f) => ({
        action: f.action,
        method: f.method,
        fieldCount: f.querySelectorAll('input,select,textarea').length,
      }));

      const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
      const stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.href);

      return { headings, links, images, forms, scripts, stylesheets };
    });
  } finally {
    await context.close();
  }
}

module.exports = { inspectPage, screenshotPage, inspectElement, getPageStructure };
