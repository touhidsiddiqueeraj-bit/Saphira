import { app, BrowserWindow, protocol, session, net, ipcMain, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { registerModelIpc } from './modelStore.js';
import { registerBrainIpc } from './brain.js';
import { registerLlmIpc, shutdownLlm } from './llm.js';
import { registerTtsIpc } from './tts.js';
import { registerSttIpc } from './stt.js';

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
              const dl = await window.saphiraDesktop.llmDownload('gemma-4-e4b');
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
        // gemma local brain: download model + mmproj + llama-server, chat text and vision
        if (process.env.SAPHIRA_SMOKE_GEMMA === '1') {
          const t0 = Date.now();
          extra.gemma = await win.webContents.executeJavaScript(`
            (async () => {
              const dl = await window.saphiraDesktop.llmDownload('gemma-4-e4b');
              const chat = await window.saphiraDesktop.brainChat({
                mode: 'local',
                system: 'You are Saphira. Always respond as JSON: {"text":"your reply","expression":"happy","intensity":0.7,"gesture":"none"}. Reply with ONLY the JSON object.',
                history: [], user: 'Say hi in one short sentence.',
              });
              // draw a red circle on white — ask what color dominates
              const c = document.createElement('canvas'); c.width = 320; c.height = 320;
              const g = c.getContext('2d');
              g.fillStyle = '#ffffff'; g.fillRect(0, 0, 320, 320);
              g.fillStyle = '#e02020'; g.beginPath(); g.arc(160, 160, 110, 0, Math.PI * 2); g.fill();
              const vis = await window.saphiraDesktop.brainChat({
                mode: 'local',
                system: 'You are Saphira. Always respond as JSON: {"text":"your reply","expression":"happy","intensity":0.7,"gesture":"none"}. Reply with ONLY the JSON object.',
                history: [], user: 'What color is the circle in this image?',
                images: [c.toDataURL('image/png')],
              });
              return { dl, chat: chat.text, vision: vis.text };
            })()`).catch((e) => ({ error: String(e) }));
          extra.gemmaSeconds = Math.round((Date.now() - t0) / 1000);
        }
        // whisper ears: kokoro speaks a line → downsample → transcribe it back
        if (process.env.SAPHIRA_SMOKE_STT === '1') {
          extra.stt = await win.webContents.executeJavaScript(`
            (async () => {
              const ttsAudio = await new Promise((resolve) => {
                let acc = [], rate = 0, lastSeen = false;
                const off = window.saphiraDesktop.onTtsChunk(({pcm, rate: r, last}) => {
                  acc.push(pcm); rate = r;
                  if (last && !lastSeen) { lastSeen = true; off(); resolve({ acc, rate }); }
                });
                window.saphiraDesktop.ttsSynthesize(999, 'The weather is lovely today.', { voice: 'af_heart', rate: 1 })
                  .catch(() => resolve(null));
                setTimeout(() => resolve(null), 60000);
              });
              if (!ttsAudio) return { error: 'tts failed' };
              const total = ttsAudio.acc.reduce((a, b) => a + b.length, 0);
              const src24 = new Int16Array(total);
              let o = 0;
              for (const c of ttsAudio.acc) { src24.set(c, o); o += c.length; }
              // 24k int16 → 16k float32 (linear resample)
              const ratio = 24000 / 16000;
              const outLen = Math.floor(total / ratio);
              const pcm16k = new Float32Array(outLen);
              for (let i = 0; i < outLen; i++) {
                const x = i * ratio, i0 = Math.floor(x), fr = x - i0;
                const a = src24[i0] / 32768, b = src24[Math.min(i0 + 1, total - 1)] / 32768;
                pcm16k[i] = a + (b - a) * fr;
              }
              const r = await window.saphiraDesktop.sttTranscribe(pcm16k);
              return { text: r.text, samplesIn: outLen, error: r.error || null };
            })()`).catch((e) => ({ error: String(e) }));
        }
        // chat voice path: the REAL SaphiraVoice.speak() with a chat-length reply
        if (process.env.SAPHIRA_SMOKE_CHATVOICE === '1') {
          extra.chatVoice = await win.webContents.executeJavaScript(`
            (async () => {
              const tts = window.__saphiraTTS;
              if (!tts) return { error: 'no tts handle' };
              let chunks = 0, samples = 0, lastSeen = false, busySeen = false;
              const off = window.saphiraDesktop.onTtsChunk(({ pcm, last }) => {
                chunks++; samples += pcm.length;
                if (last) lastSeen = true;
              });
              const t0 = performance.now();
              const busyPoll = setInterval(() => {
                if (document.getElementById('micBtn').classList.contains('busy')) busySeen = true;
              }, 100);
              const ok = await tts.speak('Hey there! I am speaking through my real chat voice path now. This sentence is long enough to be split into multiple chunks, just like an actual reply during our conversation.');
              clearInterval(busyPoll); off();
              return { ok, chunks, samples, lastSeen, busySeen, ms: Math.round(performance.now() - t0) };
            })()`).catch((e) => ({ error: String(e) }));
        }
        // kokoro voice: download model + synthesize a line, verify PCM streams back
        if (process.env.SAPHIRA_SMOKE_TTS === '1') {
          extra.tts = await win.webContents.executeJavaScript(`
            (async () => {
              return await new Promise((resolve) => {
                let chunks = 0, samples = 0, rate = 0, lastSeen = false;
                const off = window.saphiraDesktop.onTtsChunk(({pcm, rate: r, last}) => {
                  chunks++; samples += pcm.length; rate = r;
                  if (last && !lastSeen) { lastSeen = true; off(); resolve({ chunks, samples, rate, lastSeen }); }
                });
                window.saphiraDesktop.ttsSynthesize(777, 'Hello! I can speak now, all by myself.', { voice: 'af_heart', rate: 1 })
                  .then((r) => { if (r.ok === false) resolve({ error: r.error }); })
                  .catch((e) => resolve({ error: String(e) }));
                setTimeout(() => resolve({ chunks, samples, rate, timeout: !lastSeen }), 240000);
              });
            })()`).catch((e) => ({ error: String(e) }));
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
  registerTtsIpc();
  registerSttIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { shutdownLlm(); });
