'use strict';

const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');

// Wire GitHub-based auto-update.
//
// Only meaningful in a packaged build: electron-builder embeds an
// app-update.yml (from the `publish` config in package.json) that points the
// updater at the GitHub Releases feed. In dev there is no such file, so this
// must only be called when app.isPackaged.
//
// getWindow() lets the "restart to install" dialog attach to the main window
// if one exists; it falls back to a standalone dialog otherwise.
//
// prepareToInstall() (optional) is awaited right before quitAndInstall so the
// app can release resources — stop the local proxy, kill any browser-fallback
// child processes — before the NSIS installer tries to close the app. Without
// it the installer can find a still-running mkEvent.exe and report that the app
// cannot be closed.
function initAutoUpdater(getWindow, prepareToInstall) {
  autoUpdater.autoDownload = true;
  // If the user dismisses the prompt, still apply the update on next quit.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    // Never crash the app over a failed update check (offline, rate limit,
    // no release yet, etc.). Just log it.
    console.error('[updater] error:', err == null ? 'unknown' : (err.message || String(err)));
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const win = typeof getWindow === 'function' ? getWindow() : undefined;
    const options = {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `mkEvent ${info && info.version ? info.version : ''} is ready to install.`.trim(),
      detail: 'Restart the app to apply the update. Your settings are preserved.',
    };
    try {
      const { response } = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      if (response === 0) {
        // Defer so the dialog fully closes before the app restarts.
        setImmediate(async () => {
          try {
            if (typeof prepareToInstall === 'function') await prepareToInstall();
          } catch (err) {
            console.error('[updater] prepare-to-install failed:', (err && err.message) || err);
          }
          autoUpdater.quitAndInstall();
        });
      }
    } catch (err) {
      console.error('[updater] prompt failed:', (err && err.message) || err);
    }
  });

  // Kick off a check. Swallow the rejection — the 'error' handler logs it.
  autoUpdater.checkForUpdates().catch(() => {});
}

module.exports = { initAutoUpdater };
