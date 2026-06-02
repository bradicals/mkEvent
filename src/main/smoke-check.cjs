'use strict';

const http = require('node:http');
const fs = require('node:fs');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data || '{}'); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

function resolvePlaywright() {
  const explicit = process.env.MKEVENT_PLAYWRIGHT_MODULE;
  for (const candidate of [explicit, 'playwright', '@playwright/test'].filter(Boolean)) {
    try {
      const mod = require(candidate);
      if (mod.chromium) return mod;
      if (mod.playwright && mod.playwright.chromium) return mod.playwright;
    } catch (_) { /* try next */ }
  }
  throw new Error('Playwright module not resolvable for smoke check');
}

// Verifies the bundled engine: proxy answers + bundled Chromium launches and closes.
async function runSmokeCheck({ resultPath } = {}) {
  const checks = [];

  try {
    const r = await getJson('http://127.0.0.1:9999/health');
    checks.push({ name: 'proxy_health', ok: r.status === 200 && r.json && r.json.ok === true });
  } catch (err) {
    checks.push({ name: 'proxy_health', ok: false, error: String((err && err.message) || err) });
  }

  try {
    const { chromium } = resolvePlaywright();
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await browser.close();
    checks.push({ name: 'chromium_launch', ok: true });
  } catch (err) {
    checks.push({ name: 'chromium_launch', ok: false, error: String((err && err.message) || err) });
  }

  const ok = checks.every((c) => c.ok);
  const result = { ok, checks, ts: new Date().toISOString() };
  if (resultPath) {
    try { fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); } catch (_) {}
  }
  return result;
}

module.exports = { runSmokeCheck };
