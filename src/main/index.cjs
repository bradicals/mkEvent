const { app, BrowserWindow, Menu, dialog, screen, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { startProxy, stopProxy, getProxyState } = require('./proxy-manager.cjs');

// Encrypted settings store (issue #10): the renderer's connection settings
// (org/event tokens, admin credentials) are encrypted with the OS user's
// credentials via safeStorage and kept out of plaintext localStorage.
// Sync IPC because the renderer loads settings synchronously at first paint;
// the file is tiny. ponytail: sendSync load, async refactor if it ever blocks.
function secureSettingsFile() {
  return path.join(app.getPath('userData'), 'secure-settings.bin');
}

ipcMain.on('secure-settings:available', (event) => {
  event.returnValue = safeStorage.isEncryptionAvailable();
});

ipcMain.on('secure-settings:load', (event) => {
  try {
    event.returnValue = safeStorage.decryptString(fs.readFileSync(secureSettingsFile()));
  } catch (_) {
    // No file yet, or decryption key changed — renderer falls back to defaults.
    event.returnValue = null;
  }
});

ipcMain.on('secure-settings:save', (event, json) => {
  try {
    fs.writeFileSync(secureSettingsFile(), safeStorage.encryptString(String(json)));
    event.returnValue = true;
  } catch (err) {
    console.warn('secure-settings save failed:', err.message);
    event.returnValue = false;
  }
});

// Custom titlebar (frameless window): the renderer draws its own
// minimize/maximize/close buttons and drives them over IPC.
Menu.setApplicationMenu(null);

ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('window:maximize-toggle', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());

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
    frame: false,
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

  window.on('maximize', () => window.webContents.send('window:maximized', true));
  window.on('unmaximize', () => window.webContents.send('window:maximized', false));

  // Menu.setApplicationMenu(null) also removes the default accelerators, so
  // re-register the dev ones we actually use.
  if (isDev) {
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      if (key === 'f12' || (input.control && input.shift && key === 'i')) window.webContents.toggleDevTools();
      else if (input.control && !input.shift && key === 'r') window.webContents.reload();
    });
  }

  // Standard right-click context menu (edit actions + inspect in dev).
  window.webContents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.isEditable || params.selectionText) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    }
    if (isDev) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: 'Inspect element', click: () => window.webContents.inspectElement(params.x, params.y) });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });

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
