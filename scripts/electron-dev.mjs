import { spawn } from 'node:child_process';
import process from 'node:process';

const rendererUrl = 'http://127.0.0.1:5173';
const children = [];

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  children.push(child);
  return child;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRenderer(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {}
    await wait(500);
  }
  throw new Error(`Timed out waiting for Vite renderer at ${url}`);
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

async function main() {
  const vite = spawnChild(npmCommand, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173']);
  vite.once('exit', (code) => {
    if (code && code !== 0) cleanup();
  });

  await waitForRenderer(rendererUrl);

  const electron = spawnChild(electronCommand, ['electron', '.'], {
    env: {
      ...process.env,
      MKEVENT_RENDERER_URL: rendererUrl,
    },
  });

  electron.once('exit', (code) => {
    cleanup();
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(error.message);
  cleanup();
  process.exit(1);
});
