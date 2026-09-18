// Dev runner: compile the Electron main/preload once, start the vite dev
// server, wait for it, then launch Electron against it.
// (Rerun after editing desktop/*.ts — tsc here is a one-shot, no watch.)
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = new URL('..', import.meta.url).pathname;

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: false, ...opts });
  p.on('exit', (code) => { if (code !== 0) process.exitCode = code; });
  return p;
}

console.log('[desktop-dev] compiling main/preload…');
run('npx', ['tsc', '-p', 'tsconfig.electron.json']);

function waitForPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (n <= 0) return reject(new Error('vite dev server never came up'));
        setTimeout(() => tick(n - 1), 500);
      });
    };
    tick(tries);
  });
}

const vite = run('npx', ['vite', '-c', 'vite.desktop.config.ts']);
await waitForPort(5174);
console.log('[desktop-dev] vite up — launching Electron…');
const electron = run('npx', ['electron', root + 'build/desktop/main.js'], {
  env: { ...process.env, SAPHIRA_DEV: '1' },
});
electron.on('exit', () => vite.kill());
