const { app, BrowserWindow, dialog, screen } = require('electron');
const path = require('path');
const { startProxy, stopProxy, getProxyState } = require('./proxy-manager.cjs');

const isDev = Boolean(process.env.MKEVENT_RENDERER_URL);
const isSmokeCheck = process.argv.includes('--smoke-check');

function smokeResultPath() {
  const arg = process.argv.find((a) => a.startsWith('--smoke-result='));
  return arg ? arg.slice('--smoke-result='.length) : null;
}

function getRendererEntry() {
  if (process.env.MKEVENT_RENDERER_URL) return process.env.MKEVENT_RENDERER_URL;
  return `file://${path.join(__dirname, '..', '..', 'dist', 'index.html')}`;
}

function createWindow() {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.cjs');

  // Clamp the initial size to the current display's work area so the window
  // never opens larger than the screen (e.g. small Windows Sandbox displays),
  // which would push the sticky footer off-screen and make it unresizable.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1480, workArea.width);
  const height = Math.min(980, workArea.height);

  const window = new BrowserWindow({
    width,
    height,
    minWidth: 760,
    minHeight: 560,
    resizable: true,
    backgroundColor: '#f6f8fb',
    title: 'mkEvent',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.loadURL(getRendererEntry());

  if (isDev) {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  return window;
}

async function boot() {
  if (app.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
  }

  const proxy = await startProxy();

  if (isSmokeCheck) {
    const { runSmokeCheck } = require('./smoke-check.cjs');
    const result = await runSmokeCheck({ resultPath: smokeResultPath() });
    await stopProxy();
    app.exit(result.ok ? 0 : 1);
    return;
  }

  if (!proxy.started) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'mkEvent proxy',
      message: 'mkEvent could not start its local proxy.',
      detail: proxy.reason || 'Please restart the app; if this persists, reinstall mkEvent.',
    }).catch(() => undefined);
  }

  const window = createWindow();

  // Auto-update only in packaged builds (dev has no app-update.yml feed).
  // Pass teardown so the updater can fully shut the proxy and any fallback
  // child processes down BEFORE the installer runs — otherwise NSIS finds a
  // running mkEvent.exe and reports "mkEvent cannot be closed".
  if (app.isPackaged) {
    require('./updater.cjs').initAutoUpdater(() => window, teardown);
  }
}

// Run teardown (stop proxy, kill fallback children) exactly once, memoizing the
// promise so concurrent quit paths share a single shutdown.
let teardownPromise = null;
function teardown() {
  if (!teardownPromise) teardownPromise = stopProxy().catch(() => {});
  return teardownPromise;
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Electron does NOT await async before-quit listeners, so awaiting teardown
// inline would let the process exit (or the installer start) mid-shutdown.
// Cancel the first quit, finish teardown, then quit for real — the second
// before-quit sees teardown already running and lets the quit proceed.
app.on('before-quit', (event) => {
  if (teardownPromise) return;
  event.preventDefault();
  teardown().finally(() => app.quit());
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

module.exports = {
  createWindow,
  getProxyState,
};
