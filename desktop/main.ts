import { app, BrowserWindow, protocol, session, net, ipcMain, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { registerModelIpc } from './modelStore.js';

// app:// is a standard, secure, fetch-capable scheme so the renderer's
// root-absolute paths (/model/ai_ohto.glb, /bg.jpg, /audio/…) resolve inside
// the packaged bundle exactly like they did on the web server.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// her piano, chatter and TTS all resume AudioContexts on first input; in a
// window there is no gesture for interval-driven speech — opt out entirely
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const isDev = !app.isPackaged && process.env.SAPHIRA_DEV === '1';
const DEV_URL = process.env.SAPHIRA_DEV_URL || 'http://localhost:5174/';

function distRoot(): string {
  // build/desktop/main.js → dist-desktop at repo root (also true inside the asar)
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../dist-desktop');
}

function mapAppUrl(requestUrl: string): string {
  const u = new URL(requestUrl);
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const root = distRoot();
  const full = path.resolve(root, '.' + p);
  if (!full.startsWith(root)) throw new Error('forbidden'); // traversal guard
  return pathToFileURL(full).toString();
}

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const fileUrl = mapAppUrl(request.url);
    return net.fetch(fileUrl);
  });
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState(): { width: number; height: number; x?: number; y?: number } {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { width: 1400, height: 900 };
  }
}

function createWindow(): BrowserWindow {
  const state = readWindowState();
  const win = new BrowserWindow({
    width: state.width, height: state.height,
    x: state.x, y: state.y,
    minWidth: 940, minHeight: 600,
    backgroundColor: '#0b0d17',
    title: 'Saphira',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(path.dirname(new URL(import.meta.url).pathname), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('resize', saveWindowState(win));
  win.on('move', saveWindowState(win));
  win.on('close', () => saveWindowState(win)());
  // links open in the real browser, never replace her window
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  if (isDev) {
    void win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadURL('app://saphira/index.html');
  }
  maybeRunSmoke(win);
  return win;
}

// SAPHIRA_SMOKE=1: wait for her to load, collect renderer facts + console
// errors into a JSON file, then quit. Lets CI/agent runs verify a packaged
// build without a human looking at the window.
function maybeRunSmoke(win: BrowserWindow): void {
  if (process.env.SAPHIRA_SMOKE !== '1') return;
  const out = process.env.SAPHIRA_SMOKE_OUT || path.join(app.getPath('userData'), 'smoke.json');
  const errors: string[] = [];
  win.webContents.on('console-message', (_e, _level, message) => errors.push(String(message).slice(0, 300)));
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void win.webContents.executeJavaScript(`({
        title: document.title,
        hasCanvas: !!document.getElementById('c'),
        hasInput: !!document.getElementById('chatInput'),
        hasMic: !!document.getElementById('micBtn'),
        hasGear: !!document.getElementById('gear'),
        bubble: document.querySelector('.bubble')?.textContent?.slice(0, 80) || null,
        avatar: typeof window.__saphiraAvatar === 'object' && window.__saphiraAvatar !== null,
        debug: window.__saphiraAvatar?.debugInfo?.() || null,
      })`).then(async (facts) => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({ ok: true, facts, errors }, null, 2));
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(out.replace(/\.json$/, '.png'), img.toPNG());
        } catch { /* screenshot best-effort */ }
      }).catch((e) => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({ ok: false, error: String(e), errors }, null, 2));
      }).finally(() => app.quit());
    }, 9000);
  });
}

function saveWindowState(win: BrowserWindow) {
  let t: NodeJS.Timeout | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      try {
        const b = win.getNormalBounds();
        fs.mkdirSync(path.dirname(statePath()), { recursive: true });
        fs.writeFileSync(statePath(), JSON.stringify(b));
      } catch { /* best effort */ }
    }, 400);
  };
}

function registerMiscIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion());
}

void app.whenReady().then(async () => {
  registerAppProtocol();
  // mic for push-to-talk; deny the rest by default
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'fullscreen');
  registerMiscIpc();
  registerModelIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
