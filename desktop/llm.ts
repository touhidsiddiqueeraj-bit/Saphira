import { ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { llmDir } from './modelStore.js';
import { setLocalChat, cloudChat, type BrainChatPayload } from './brain.js';

// Local brain = the official llama.cpp `llama-server` binary speaking the same
// OpenAI-compatible protocol as the cloud brains — text AND images (Gemma 4's
// mtmd vision via --mmproj). The binary (~18 MB) and model files download once
// into <userData>/models/llm; after that she thinks fully offline.

const LLAMA_SERVER_DIR = () => path.join(llmDir(), 'llama-server');

type CatalogEntry = {
  id: string;
  label: string;
  file: string;               // main GGUF in llmDir()
  url: string;
  bytes: number;
  mmprojFile?: string;        // vision projector; present = model can see
  mmprojUrl?: string;
  mmprojBytes?: number;
  vision: boolean;
  recommended?: boolean;
};

// Gemma 3n E2B is text-only under llama.cpp today (no projector exists);
// Gemma 4 E4B carries official mtmd vision support.
const CATALOG: CatalogEntry[] = [
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B — sharper, sees images (~5.1 GB)',
    file: 'gemma-4-E4B-it-Q4_0.gguf',
    url: 'https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_0.gguf',
    bytes: 4_590_000_000,
    mmprojFile: 'mmproj-gemma-4-E4B-it-Q8_0.gguf',
    mmprojUrl: 'https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/mmproj-gemma-4-E4B-it-Q8_0.gguf',
    mmprojBytes: 559_000_000,
    vision: true,
    recommended: true,
  },
  {
    id: 'gemma-3n-e2b',
    label: 'Gemma 3n E2B — light (~3 GB)',
    file: 'gemma-3n-E2B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-3n-E2B-it-GGUF/resolve/main/gemma-3n-E2B-it-Q4_K_M.gguf',
    bytes: 3_026_888_188,
    vision: false,
  },
];

type ModelState = 'not-downloaded' | 'downloading' | 'loading' | 'ready' | 'error';
const transient = new Map<string, { state: ModelState; progress?: number; error?: string }>();
const activeFile = () => path.join(llmDir(), 'active.json');

let serverProc: ChildProcess | null = null;
let serverPort = 0;
let serverModelId: string | null = null;
let bootPromise: Promise<void> | null = null;
let loadSeq = 0;

function emit(e: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('llm:event', e); } catch { /* gone */ }
  }
}

function fileFor(rel: string | undefined): string | null {
  if (!rel) return null;
  const p = path.join(llmDir(), rel);
  return fs.existsSync(p) ? p : null;
}

function readActiveId(): string | null {
  try { return JSON.parse(fs.readFileSync(activeFile(), 'utf8')).id ?? null; } catch { return null; }
}

function writeActiveId(id: string | null): void {
  fs.mkdirSync(llmDir(), { recursive: true });
  fs.writeFileSync(activeFile(), JSON.stringify({ id }));
}

// ---------- llama-server binary management ----------

function platformAsset(): { asset: RegExp; kind: 'tar.gz' | 'zip' } {
  return process.platform === 'win32'
    ? { asset: /llama-b\d+-bin-win-cpu-x64\.zip$/, kind: 'zip' }
    : { asset: /llama-b\d+-bin-ubuntu-x64\.tar\.gz$/, kind: 'tar.gz' };
}

async function latestBinaryAsset(): Promise<{ url: string; name: string }> {
  const res = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20', {
    headers: { 'User-Agent': 'saphira-desktop' },
  });
  const releases: any[] = await res.json() as any[];
  const { asset } = platformAsset();
  for (const r of releases) {
    if (!/^b\d+$/.test(r.tag_name || '')) continue;
    const a = (r.assets || []).find((x: any) => asset.test(x.name));
    if (a) return { url: a.browser_download_url, name: a.name };
  }
  throw new Error('no llama-server release found');
}

function dirEntries(dir: string): string[] { try { return fs.readdirSync(dir); } catch { return []; } }

function findFile(root: string, name: string): string | null {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of dirEntries(dir)) {
      const full = path.join(dir, e);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else if (e === name) return full;
    }
  }
  return null;
}

async function ensureServerBinary(): Promise<string> {
  const dir = LLAMA_SERVER_DIR();
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const found = findFile(dir, exeName);
  if (found) return found;
  emit({ type: 'state', modelId: '__server__', state: 'loading' });
  const { url, name } = await latestBinaryAsset();
  const archive = path.join(dir, name);
  await downloadTo(url, archive);
  if (name.endsWith('.zip')) {
    const AdmZip = (await import('adm-zip')).default;
    new AdmZip(archive).extractAllTo(dir, true);
  } else {
    await new Promise<void>((resolve, reject) => {
      execFile('tar', ['-xzf', archive, '-C', dir], (err) => err ? reject(err) : resolve());
    });
  }
  fs.rmSync(archive, { force: true });
  const bin = findFile(dir, exeName);
  if (!bin) throw new Error('llama-server not found in archive');
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  return bin;
}

async function downloadTo(url: string, dest: string, modelId?: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0; let lastPct = -10;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total && modelId) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 3) {
        lastPct = pct;
        transient.set(modelId, { state: 'downloading', progress: got / total });
        emit({ type: 'progress', modelId, progress: got / total });
      }
    }
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

// ---------- server lifecycle ----------

async function fetchHealth(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    if (r.status === 200) return true;
  } catch { /* not up yet */ }
  return false;
}

async function ensureServer(): Promise<number> {
  const want = readActiveId();
  if (serverProc && serverPort && serverModelId === want && (await fetchHealth(serverPort))) return serverPort;
  if (bootPromise) return bootPromise.then(() => serverPort);
  bootPromise = (async () => {
    const seq = ++loadSeq;
    const id = want!;
    const entry = CATALOG.find((c) => c.id === id);
    const modelPath = entry ? fileFor(entry.file) : null;
    if (!entry || !modelPath) throw new Error('No local model downloaded yet');
    transient.set(id, { state: 'loading' });
    emit({ type: 'state', modelId: id, state: 'loading' });
    try {
      stopServer(); // kill any previous instance (model may differ)
      const bin = await ensureServerBinary();
      const port = 18963;
      const args = ['-m', modelPath, '-c', '8192', '--port', String(port), '--host', '127.0.0.1', '--no-webui'];
      const mmproj = fileFor(entry.mmprojFile);
      if (mmproj) args.push('--mmproj', mmproj);
      serverProc = spawn(bin, args, { cwd: path.dirname(bin), stdio: 'ignore' });
      serverModelId = id;
      serverPort = port;
      // wait for /health (model load can take a while)
      const deadline = Date.now() + 180_000;
      let up = false;
      while (Date.now() < deadline) {
        if (seq !== loadSeq) return; // superseded by a newer boot
        if (serverProc.exitCode !== null) throw new Error('llama-server exited during startup');
        if (await fetchHealth(port)) { up = true; break; }
        await new Promise((r) => setTimeout(r, 800));
      }
      if (!up) throw new Error('llama-server did not become healthy');
      transient.set(id, { state: 'ready' });
      emit({ type: 'state', modelId: id, state: 'ready' });
    } catch (e: any) {
      stopServer();
      const msg = String(e?.message || e).slice(0, 200);
      transient.set(id, { state: 'error', error: msg });
      emit({ type: 'state', modelId: id, state: 'error', error: msg });
      throw e;
    } finally {
      bootPromise = null;
    }
  })();
  return bootPromise.then(() => serverPort);
}

function stopServer(): void {
  if (serverProc) {
    try { serverProc.kill(); } catch { /* already gone */ }
    serverProc = null;
  }
  serverPort = 0;
  serverModelId = null;
}

// ---------- downloads ----------

let downloading = false;
async function download(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = CATALOG.find((c) => c.id === modelId);
  if (!entry) return { ok: false, error: 'unknown model' };
  if (downloading) return { ok: false, error: 'already downloading' };
  downloading = true;
  try {
    await ensureServerBinary(); // small — fetch the engine before the big model
    emit({ type: 'state', modelId, state: 'downloading', progress: 0 });
    await downloadTo(entry.url, path.join(llmDir(), entry.file), modelId);
    if (entry.mmprojUrl && entry.mmprojFile) {
      await downloadTo(entry.mmprojUrl, path.join(llmDir(), entry.mmprojFile), modelId);
    }
    writeActiveId(modelId);
    void ensureServer().catch(() => { /* surfaced via state events */ });
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 200);
    transient.set(modelId, { state: 'error', error: msg });
    emit({ type: 'state', modelId, state: 'error', error: msg });
    return { ok: false, error: msg };
  } finally {
    downloading = false;
  }
}

// ---------- chat ----------

async function localChat(p: BrainChatPayload): Promise<string> {
  const port = await ensureServer();
  return cloudChat({ ...p, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'no-key' });
}

// ---------- ipc ----------

export function registerLlmIpc(): void {
  ipcMain.handle('llm:catalog', () => CATALOG);
  ipcMain.handle('llm:status', () => ({
    models: CATALOG.map((c) => {
      const t = transient.get(c.id);
      const downloaded = !!fileFor(c.file);
      const state: ModelState = t?.state === 'downloading' ? 'downloading'
        : t?.state === 'loading' ? 'loading'
        : t?.state === 'error' ? 'error'
        : (t?.state === 'ready' || downloaded) ? 'ready'
        : 'not-downloaded';
      return { ...c, state, progress: t?.progress, error: t?.error };
    }),
    activeId: readActiveId(),
  }));
  ipcMain.handle('llm:download', (_e, modelId: string) => download(modelId));
  ipcMain.handle('llm:select', async (_e, modelId: string) => {
    if (!fileFor(CATALOG.find((c) => c.id === modelId)?.file)) return { ok: false, error: 'model not downloaded' };
    writeActiveId(modelId);
    void ensureServer().catch(() => {});
    return { ok: true };
  });
  setLocalChat(localChat);
}

/** call on app quit so llama-server doesn't linger */
export function shutdownLlm(): void {
  stopServer();
}
