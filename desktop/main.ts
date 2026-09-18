import { app, BrowserWindow, protocol, session, net, ipcMain, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { registerModelIpc } from './modelStore.js';
import { registerBrainIpc } from './brain.js';
import { registerLlmIpc } from './llm.js';

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
  const write = async (payload: unknown) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out.replace(/\.json$/, '.png'), img.toPNG());
    } catch { /* screenshot best-effort */ }
    app.quit();
  };
  win.webContents.on('console-message', (_e, _level, message) => errors.push(String(message).slice(0, 300)));
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void (async () => {
        const extra: any = {};
        // cloud-brain chain via the localhost mock endpoint
        if (process.env.SAPHIRA_MOCK_BRAIN === '1') {
          const port = await startMockBrain();
          const t = await win.webContents.executeJavaScript(`
            (async () => {
              const r = await window.saphiraDesktop.brainChat({
                mode: 'cloud', baseUrl: 'http://127.0.0.1:${port}', apiKey: 'smoke', model: 'mock',
                system: 'test', history: [], user: 'hi',
              });
              return r.text;
            })()`);
          extra.mockBrainReply = t;
          extra.mockBrainOk = t.includes('Mock brain here.');
        }
        // full local-brain chain: download GGUF → load → chat (slow, opt-in)
        if (process.env.SAPHIRA_SMOKE_LOCAL === '1') {
          const t0 = Date.now();
          extra.local = await win.webContents.executeJavaScript(`
            (async () => {
              const dl = await window.saphiraDesktop.llmDownload('qwen2.5-1.5b');
              const st = await window.saphiraDesktop.llmStatus();
              const chat = await window.saphiraDesktop.brainChat({
                mode: 'local',
                system: 'You are Saphira, a friendly anime companion. Always respond as JSON: {"text":"your reply","expression":"happy","intensity":0.7,"gesture":"none"}. Reply with ONLY the JSON object.',
                history: [], user: 'Say hi and tell me your name in one short sentence.',
              });
              return { dl, activeId: st.activeId, chat: chat.text };
            })()`).catch((e) => ({ error: String(e) }));
          extra.localSeconds = Math.round((Date.now() - t0) / 1000);
        }
        const facts = await win.webContents.executeJavaScript(`({
          title: document.title,
          hasCanvas: !!document.getElementById('c'),
          hasInput: !!document.getElementById('chatInput'),
          hasMic: !!document.getElementById('micBtn'),
          hasGear: !!document.getElementById('gear'),
          brainSectionVisible: (() => { const b = document.getElementById('brainSection'); return !!b && b.style.display !== 'none'; })(),
          brainPresetCount: (document.getElementById('brainPreset')?.options || []).length,
          bubble: document.querySelector('.bubble')?.textContent?.slice(0, 80) || null,
          avatar: typeof window.__saphiraAvatar === 'object' && window.__saphiraAvatar !== null,
          debug: window.__saphiraAvatar?.debugInfo?.() || null,
        })`);
        await write({ ok: true, facts: { ...facts, ...extra }, errors });
      })().catch(async (e) => {
        await write({ ok: false, error: String(e), errors });
      });
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

// SAPHIRA_MOCK_BRAIN=1: a localhost OpenAI-compatible stub so smoke tests can
// exercise the full renderer→preload→IPC→brain→reply chain with no API key.
const MOCK_REPLY = JSON.stringify({ text: 'Hello! Mock brain here.', expression: 'happy', intensity: 0.8, gesture: 'none' });
async function startMockBrain(): Promise<number> {
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: MOCK_REPLY } }] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return (srv.address() as any).port as number;
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
  registerBrainIpc();
  registerLlmIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
