'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { startProxyServer, closeServer } = require('./proxy-server.cjs');

let server = null;
let proxyState = { started: false, command: 'node-inproc', pid: null, reason: '' };

// Live browser-fallback child processes. Each is a separate mkEvent.exe running
// as Node (ELECTRON_RUN_AS_NODE) that drives Playwright Chromium. If any of
// these are alive when an auto-update installs, the NSIS installer sees a running
// mkEvent.exe and reports "mkEvent cannot be closed", so they must be force-killed
// (whole tree, including the Chromium grandchildren) on shutdown.
const childProcesses = new Set();

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // /T kills the whole tree (Chromium children), /F forces it.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (_) { /* process already gone */ }
}

function killChildProcesses() {
  for (const child of childProcesses) {
    killProcessTree(child.pid);
  }
  childProcesses.clear();
}

// Mirror of proxy-server.py _browser_fallback_timeout_seconds, in milliseconds.
function browserFallbackTimeoutMs(payload) {
  const action = String(payload.action || '');
  if (action === 'post-create-activity') {
    const a = payload.postCreateActivity || {};
    const tp = a.ticketPurchases || {};
    const au = a.auctionActivity || {};
    const dn = a.donationActivity || {};
    const tpc = (tp.enabled !== false) ? Math.max(0, Number(tp.purchaseCount) || 0) : 0;
    const bc = au.enabled ? Math.max(0, Number(au.bidCount) || 0) : 0;
    const mbc = au.enabled ? Math.max(0, Number(au.maxBidCount) || 0) : 0;
    const ddc = dn.enabled ? Math.max(0, Number(dn.donationCount) || 0) : 0;
    const t = 180 + (tpc * 35) + ((bc + mbc) * 6) + (ddc * 6);
    return Math.max(300, Math.min(1200, t)) * 1000;
  }
  return 300 * 1000;
}

function trimText(value, limit = 20000) {
  const text = String(value == null ? '' : value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

function resourceRoot() {
  // Packaged: resources/. Dev: project root (two levels up from src/main).
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
}

function browserFallbackScriptPath() {
  // browser-fallback.cjs is asarUnpack'd, so resolve it under app.asar.unpacked when packaged.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'browser-fallback.cjs');
  }
  return path.join(__dirname, '..', '..', 'browser-fallback.cjs');
}

// Run browser-fallback.cjs as a Node script using the Electron binary (ELECTRON_RUN_AS_NODE).
// `log` is the proxy file logger so browser_fallback_exit detail lands in the
// debug report (parity with proxy-server.py).
function makeRunBrowserFallback(log) {
  return function runBrowserFallback(payload) {
    return new Promise((resolve, reject) => {
      const scriptPath = browserFallbackScriptPath();
      if (!fs.existsSync(scriptPath)) {
        reject(new Error(`Browser fallback script not found: ${scriptPath}`));
        return;
      }

      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      // Give the fallback a real, writable place for failure screenshots
      // instead of its hardcoded default.
      try { env.MKEVENT_LOG_DIR = path.join(app.getPath('userData'), 'logs'); } catch (_) {}
      if (app.isPackaged) {
        env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
      }

      const child = spawn(process.execPath, [scriptPath], {
        cwd: resourceRoot(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      childProcesses.add(child);

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

      const timer = setTimeout(() => {
        killProcessTree(child.pid);
        const err = new Error('Browser fallback timed out');
        err.code = 'timeout';
        finish(reject, err);
      }, browserFallbackTimeoutMs(payload));

      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { childProcesses.delete(child); finish(reject, err); });
      child.on('close', (code) => {
        childProcesses.delete(child);
        log('browser_fallback_exit', {
          action: payload.action,
          returncode: code,
          stdout: trimText(stdout),
          stderr: trimText(stderr),
        });
        if (code !== 0) { finish(reject, new Error((stderr || stdout || 'browser fallback failed').trim())); return; }
        try { finish(resolve, JSON.parse(stdout || '{}')); }
        catch (err) { finish(reject, new Error(`Browser fallback returned invalid JSON: ${err.message}`)); }
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  };
}

// Returns { logger, logPath } so /debug/logs can tail the same file the logger writes.
function makeFileLogger() {
  let logPath;
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'mkEvent-proxy.log');
  } catch (_) {
    logPath = null;
  }
  const logger = (event, fields) => {
    if (!logPath) return;
    const record = JSON.stringify({ ts: new Date().toISOString(), event, ...(fields || {}) });
    try { fs.appendFileSync(logPath, record + '\n'); } catch (_) {}
  };
  return { logger, logPath };
}

async function startProxy() {
  if (server) return proxyState;
  try {
    const { logger, logPath } = makeFileLogger();
    server = await startProxyServer({
      host: '127.0.0.1',
      port: 9999,
      runBrowserFallback: makeRunBrowserFallback(logger),
      logger,
      logPath,
    });
    proxyState = { started: true, command: 'node-inproc', pid: process.pid, reason: '' };
  } catch (err) {
    server = null;
    proxyState = { started: false, command: 'node-inproc', pid: null, reason: err.message };
  }
  return proxyState;
}

async function stopProxy() {
  // Always tear down fallback children first — they can be alive even when the
  // proxy server itself is already gone.
  killChildProcesses();
  if (!server) return;
  const current = server;
  server = null;
  await closeServer(current);
  proxyState = { started: false, command: 'node-inproc', pid: null, reason: 'stopped' };
}

function getProxyState() {
  return proxyState;
}

module.exports = { getProxyState, startProxy, stopProxy };
