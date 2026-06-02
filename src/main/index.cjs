const { app, BrowserWindow, dialog } = require('electron');
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
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 820,
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

  createWindow();
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    await stopProxy();
    app.quit();
  }
});

app.on('before-quit', async () => {
  await stopProxy();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

module.exports = {
  createWindow,
  getProxyState,
};
