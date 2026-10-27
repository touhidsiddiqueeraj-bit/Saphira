import { ipcMain, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { llmDir } from './modelStore.js';
import { setLocalChat, cloudChat, type BrainChatPayload } from './brain.js';

// Local brain = the official llama.cpp `llama-server` binary speaking the same
// OpenAI-compatible protocol as the cloud brains — text AND images (Gemma 4's
// mtmd vision via --mmproj). The binary (~18 MB) and model files download once
// into <userData>/models/llm; after that she thinks fully offline.
//
// Memory safety (the "PC ran out of RAM and died" fix):
//   1. preflightRam()     — never start a brain the machine cannot hold
//   2. planGpu()          — parse the GPU's real VRAM and offload only what fits
//   3. startWatchdog()    — if system memory runs critically low while she
//                           thinks, llama-server is killed before the kernel
//                           starts killing things at random (or the box hangs)
//   4. OOM-exit retry     — a GPU overcommit falls back to CPU automatically
//   5. startIdleTimer()   — a brain unused for 20 min is parked so the user's
//                           other apps get their memory back

const LLAMA_SERVER_DIR = () => path.join(llmDir(), 'llama-server');

// known model libraries — the catalog resolves GGUFs from here first so
// locally-stored models are used instead of re-downloading. The user can add
// their own folder in settings (scan-dirs.json), so nothing is hardcoded.
function scanDirs(): string[] {
  const dirs = [llmDir()];
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(llmDir(), 'scan-dirs.json'), 'utf8'));
    for (const d of Array.isArray(extra) ? extra : []) {
      if (typeof d === 'string' && d.trim()) dirs.push(d.trim());
    }
  } catch { /* no custom dirs yet */ }
  return dirs;
}

function findInDirs(rel: string | undefined, minBytes?: number): string | null {
  if (!rel) return null;
  for (const d of scanDirs()) {
    const p = path.join(d, rel);
    try {
      const st = fs.statSync(p);
      // an interrupted download leaves a truncated file — treat it as missing
      // so it gets re-downloaded instead of crashing the brain at load time
      if (st.isFile() && (!minBytes || st.size >= minBytes * 0.9)) return p;
    } catch { /* dir or file missing */ }
  }
  return null;
}

// pick the catalog entry whose files we actually have, preferring the saved
// choice — a stale active.json (model removed/renamed) must self-heal
function resolveUsableEntry(): CatalogEntry | null {
  const saved = CATALOG.find((c) => c.id === readActiveId());
  if (saved && findInDirs(saved.file)) return saved;
  return CATALOG.find((c) => findInDirs(c.file)) ?? null;
}

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

let serverProc: (ChildProcess & { exitTail?: () => string }) | null = null;
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

const ENGINE_CANDIDATES = () => [
  path.join(process.env.HOME || '', 'llama.cpp', 'build', 'bin', 'llama-server' + (process.platform === 'win32' ? '.exe' : '')),
];

let engineBinary: string | null = null;
let engineGpu = false;
let engineVram: number | null = null;

async function ensureServerBinary(): Promise<string> {
  if (engineBinary) return engineBinary;
  // 1) existing installs — typically a GPU (Vulkan) build
  for (const cand of ENGINE_CANDIDATES()) {
    try {
      if (fs.existsSync(cand)) {
        engineBinary = cand;
        const info = await detectGpu(cand);
        engineGpu = info.gpu; engineVram = info.vramBytes;
        return cand;
      }
    } catch { /* not there */ }
  }
  // 2) previously downloaded official build — remember it AND probe the GPU
  //    (the old code forgot the probe here, so GPU offload silently vanished
  //    on every run after the first)
  const dir = LLAMA_SERVER_DIR();
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const found = findFile(dir, exeName);
  if (found) {
    engineBinary = found;
    const info = await detectGpu(found);
    engineGpu = info.gpu; engineVram = info.vramBytes;
    return found;
  }
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
  engineBinary = bin;
  const info = await detectGpu(bin);
  engineGpu = info.gpu; engineVram = info.vramBytes;
  return bin;
}

// --list-devices prints one line per accelerator, usually with its memory, e.g.
//   Vulkan0: AMD Radeon RX 580 | 8 GB (8152.0 MiB)   — or —   CUDA0: ... (12 GB)
// GPU present → offload what FITS (see planGpu); else stay on CPU.
type GpuInfo = { gpu: boolean; vramBytes: number | null };
async function detectGpu(bin: string): Promise<GpuInfo> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(bin, ['--list-devices'], { timeout: 15000 }, (err, stdout) => err ? reject(err) : resolve(String(stdout)));
    });
    if (!/Vulkan\d|CUDA\d|SYCL\d|ROCm/i.test(out)) return { gpu: false, vramBytes: null };
    let vram: number | null = null;
    for (const line of String(out).split('\n')) {
      if (!/Vulkan\d|CUDA\d|SYCL\d|ROCm/i.test(line)) continue;
      let bytes = 0;
      const mib = /(\d[\d\s.,]*)\s*MiB/i.exec(line);
      const gib = /(\d+(?:[.,]\d+)?)\s*(?:GiB|GB)/i.exec(line);
      if (mib) bytes = parseFloat(mib[1].replace(/[\s,]/g, '')) * 1024 * 1024;
      else if (gib) bytes = parseFloat(gib[1].replace(',', '.')) * 1024 ** 3;
      if (bytes > (vram ?? 0)) vram = bytes;
    }
    return { gpu: true, vramBytes: vram };
  } catch { return { gpu: false, vramBytes: null }; }
}

async function downloadTo(url: string, dest: string, modelId?: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0; let lastPct = -10;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (total && modelId) {
        const pct = Math.floor((got / total) * 100);
        if (pct >= lastPct + 3) {
          lastPct = pct;
          transient.set(modelId, { state: 'downloading', progress: got / total });
          emit({ type: 'progress', modelId, progress: got / total });
        }
      }
      cb(null, chunk);
    },
  });
  // stream straight to disk — multi-GB models must never buffer in RAM
  await streamPipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(dest));
}

// ---------- memory planning ----------

// KV cache upper bound for Gemma-class models (~0.125 MiB per token per full
// stack, f16 K+V). Erring high is safe: it only makes us offload less.
const KV_PER_TOKEN = 131_072;
const ESTIMATED_LAYERS = 40; // Gemma-class; a wrong guess falls back via the OOM retry

type GpuPlan = { ngl: number; ctx: number; note?: string };

// Decide how many layers go to the GPU. The old code blindly passed
// `-ngl 99` — on an 8 GB card a 5 GB model + projector + KV + compute buffers
// overcommits VRAM, the Vulkan driver spills into system RAM, and the whole
// machine ends up OOM. Now: only what actually fits.
function planGpu(modelBytes: number, mmprojBytes: number): GpuPlan {
  const ctx = 4096; // halves KV cache + prompt-eval time vs the old 8192
  if (!engineGpu) return { ngl: 0, ctx };
  const kv = ctx * KV_PER_TOKEN;
  const weights = modelBytes + mmprojBytes;
  if (engineVram && engineVram > 0) {
    const usable = engineVram - 900 * 1024 * 1024; // display + driver + compute headroom
    if (weights + kv <= usable) return { ngl: 99, ctx };
    const layerBytes = weights / ESTIMATED_LAYERS;
    const ngl = Math.max(0, Math.min(99, Math.floor((usable - kv - 200 * 1024 * 1024) / layerBytes)));
    return {
      ngl, ctx,
      note: ngl > 0
        ? `GPU memory is tight — offloading ${ngl} of ~${ESTIMATED_LAYERS} layers, rest on CPU`
        : 'Not enough GPU memory for this brain — running on CPU',
    };
  }
  // VRAM unknown: full offload, the OOM-exit retry below is the safety net
  return { ngl: 99, ctx };
}

// never boot a brain the machine cannot hold — a 5 GB model on a 4 GB PC used
// to take the whole system down with it
function preflightRam(plan: GpuPlan, modelBytes: number, mmprojBytes: number): string | null {
  const weights = modelBytes + mmprojBytes;
  const kv = plan.ctx * KV_PER_TOKEN;
  const offFrac = plan.ngl >= 99 ? 1 : plan.ngl / ESTIMATED_LAYERS;
  const hostShare = weights * Math.max(0.15, 1 - offFrac);
  const need = hostShare + kv + 1.6e9; // her app (Electron + TTS + STT) + OS headroom
  const total = os.totalmem();
  if (total < need) {
    return `Not enough memory for this brain — needs ~${(need / 1e9).toFixed(1)} GB, this PC has ${(total / 1e9).toFixed(1)} GB. Try the lighter Gemma 3n in ⚙ settings.`;
  }
  return null;
}

// stderr signatures of a dead-from-OOM llama-server
const OOM_EXIT_RE = /out of (device |host )?memory|VK_ERROR_OUT_OF_(DEVICE|HOST)_MEMORY|std::bad_alloc|allocation failed|failed to allocate|CUDA error|ggml_backend.*alloc|insufficient memory/i;

// system memory that is actually free (Linux: MemAvailable counts reclaimable
// cache; os.freemem() does not and cries wolf far too early)
function memAvailable(): number | null {
  if (process.platform === 'linux') {
    try {
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) return Number(m[1]) * 1024;
    } catch { /* not procfs */ }
  }
  return os.freemem();
}

// ---------- server lifecycle ----------

// pick a port that is actually free — a leftover llama-server on 18963 used
// to make the new spawn die on bind and read as 'exited during startup'
async function freePort(start: number): Promise<number> {
  const { createServer } = await import('node:net');
  for (let p = start; p < start + 25; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  return start;
}

async function fetchHealth(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    if (r.status === 200) return true;
  } catch { /* not up yet */ }
  return false;
}

function buildServerArgs(modelPath: string, port: number, mmproj: string | null, plan: GpuPlan): string[] {
  const args = ['-m', modelPath, '-c', String(plan.ctx), '--port', String(port), '--host', '127.0.0.1', '--no-webui', '--jinja',
    '--reasoning-budget', '0']; // she must answer fast, not think — thinking burns tokens before the JSON
  if (plan.ngl > 0) {
    args.push('-ngl', String(plan.ngl));
    // flash-attn only on full offload — matches the previously proven GPU
    // path; partial-offload/CPU setups keep the conservative default
    if (plan.ngl >= 99) args.push('--flash-attn', 'on');
  } else {
    // CPU-only: leave two cores for the OS and her own UI so she never
    // freezes the machine while thinking
    const cores = os.cpus().length;
    if (cores > 4) args.push('-t', String(Math.max(2, cores - 2)));
  }
  if (mmproj) args.push('--mmproj', mmproj);
  return args;
}

function spawnLlama(bin: string, args: string[], cwd: string): ChildProcess & { exitTail?: () => string } {
  // AppImages export LD_LIBRARY_PATH into their bundled libs; llama-server
  // inheriting that crashes at load. Give it a clean environment.
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH; delete env.LD_PRELOAD;
  delete env.APPDIR; delete env.APPIMAGE; delete env.ARGV0;
  const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env });
  const errTail: string[] = [];
  proc.stderr?.on('data', (d: Buffer) => {
    errTail.push(String(d));
    if (errTail.length > 40) errTail.shift();
  });
  (proc as ChildProcess & { exitTail?: () => string }).exitTail = () => errTail.join('').slice(-500);
  return proc as ChildProcess & { exitTail?: () => string };
}

// memory watchdog: if free system memory is about to run out while she
// thinks, drop the multi-GB brain before the kernel OOM-killer takes down the
// session (or the machine hard-hangs — the "PC just shut down" report)
let watchdogTimer: NodeJS.Timeout | null = null;
const MEMORY_STOP_MSG = 'She ran out of memory — her brain was stopped to protect this PC. Try the lighter Gemma 3n model in ⚙ settings.';
let oomStopped = false;
let oomStoppedFor: string | null = null;

function startWatchdog(id: string): void {
  stopWatchdog();
  const total = os.totalmem();
  const critical = Math.min(600 * 1024 * 1024, Math.max(250 * 1024 * 1024, Math.floor(total * 0.06)));
  watchdogTimer = setInterval(() => {
    if (!serverProc) { stopWatchdog(); return; }
    const avail = memAvailable();
    if (avail == null || avail > critical) return;
    const proc = serverProc;
    stopServer();
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    oomStopped = true;
    oomStoppedFor = id;
    transient.set(id, { state: 'error', error: MEMORY_STOP_MSG });
    emit({ type: 'state', modelId: id, state: 'error', error: MEMORY_STOP_MSG });
  }, 2500);
}
function stopWatchdog(): void { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; } }

// idle park: a brain that has not been used for 20 minutes is shut down so
// the memory goes back to whatever else the user is doing. The next message
// re-wakes her (the renderer shows a "waking her brain" note while loading).
const IDLE_SHUTDOWN_MS = 20 * 60_000;
let idleTimer: NodeJS.Timeout | null = null;
let lastUsedAt = 0;
function touchUse(): void { lastUsedAt = Date.now(); }
function startIdleTimer(): void {
  stopIdleTimer();
  idleTimer = setInterval(() => {
    if (!serverProc) { stopIdleTimer(); return; }
    if (Date.now() - lastUsedAt < IDLE_SHUTDOWN_MS) return;
    stopServer();
  }, 60_000);
}
function stopIdleTimer(): void { if (idleTimer) { clearInterval(idleTimer); idleTimer = null; } }

async function ensureServer(): Promise<number> {
  const want = readActiveId();
  if (serverProc && serverPort && serverModelId === want && (await fetchHealth(serverPort))) { touchUse(); return serverPort; }
  if (bootPromise) return bootPromise.then(() => serverPort);
  bootPromise = (async () => {
    const seq = ++loadSeq;
    const entry = resolveUsableEntry();
    const id = entry?.id ?? want ?? 'local';
    const modelPath = entry ? findInDirs(entry.file, entry.bytes) : null;
    if (!entry || !modelPath) {
      throw new Error('No local model found — pick one in Settings, or add your models folder there');
    }
    if (oomStopped && id === oomStoppedFor) {
      throw new Error(MEMORY_STOP_MSG);
    }
    if (entry.id !== want) writeActiveId(entry.id);
    transient.set(id, { state: 'loading' });
    emit({ type: 'state', modelId: id, state: 'loading' });
    try {
      stopServer(); // kill any previous instance (model may differ)
      const bin = await ensureServerBinary();
      const port = await freePort(18963);
      const mmproj = findInDirs(entry.mmprojFile, entry.mmprojBytes);
      let multimodal = !!mmproj;
      const modelBytes = fs.statSync(modelPath).size;
      const mmprojBytes = mmproj ? fs.statSync(mmproj).size : 0;
      const plan = planGpu(modelBytes, mmprojBytes);
      if (plan.note) emit({ type: 'state', modelId: id, state: 'loading', error: plan.note });
      const ramErr = preflightRam(plan, modelBytes, mmprojBytes);
      if (ramErr) throw new Error(ramErr);
      const cwd = path.dirname(bin);
      let args = buildServerArgs(modelPath, port, mmproj, plan);
      serverProc = spawnLlama(bin, args, cwd);
      serverModelId = id;
      serverPort = port;
      touchUse();
      // wait for /health (model load can take a while)
      const deadline = Date.now() + 180_000;
      let up = false;
      let mmprojRetried = false;
      let oomRetried = false;
      while (Date.now() < deadline) {
        if (seq !== loadSeq) return; // superseded by a newer boot
        if (serverProc.exitCode !== null) {
          const tail = serverProc.exitTail ? serverProc.exitTail() : '';
          // GPU overcommit: retry once on CPU with a smaller context — a reply
          // beats a hard system freeze
          if (!oomRetried && engineGpu && OOM_EXIT_RE.test(tail)) {
            oomRetried = true;
            const cpuPlan: GpuPlan = { ngl: 0, ctx: 2048 };
            const cpuRamErr = preflightRam(cpuPlan, modelBytes, mmprojBytes);
            if (cpuRamErr) throw new Error(cpuRamErr);
            args = buildServerArgs(modelPath, port, mmproj, cpuPlan);
            serverProc = spawnLlama(bin, args, cwd);
            touchUse();
            emit({ type: 'state', modelId: id, state: 'loading', error: 'Ran out of GPU memory — retrying on CPU (slower but safe)' });
            continue;
          }
          // a broken projector shouldn't take the whole brain down —
          // retry once text-only and let text chat keep working
          if (multimodal && !mmprojRetried && /multimodal|mmproj/i.test(tail)) {
            mmprojRetried = true;
            multimodal = false;
            args = args.filter((a, i) => !(a === '--mmproj' || (i > 0 && args[i - 1] === '--mmproj')));
            serverProc = spawnLlama(bin, args, cwd);
            touchUse();
            emit({ type: 'state', modelId: id, state: 'loading', error: 'vision projector failed to load — running text-only' });
            continue;
          }
          throw new Error(`llama-server exited (code ${serverProc.exitCode}) ${tail.slice(-300)}`);
        }
        if (await fetchHealth(port)) { up = true; break; }
        await new Promise((r) => setTimeout(r, 800));
      }
      if (!up) throw new Error('llama-server did not become healthy');
      startWatchdog(id);
      startIdleTimer();
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
  stopWatchdog();
  stopIdleTimer();
  const proc = serverProc;
  serverProc = null;
  serverPort = 0;
  serverModelId = null;
  if (proc) {
    try { proc.kill(); } catch { /* already gone */ }
    // SIGTERM refused (stuck in a GPU driver call is common mid-OOM) — escalate
    const hard = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    proc.once('exit', () => clearTimeout(hard));
  }
}

// ---------- downloads ----------

let downloading = false;
async function download(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = CATALOG.find((c) => c.id === modelId);
  if (!entry) return { ok: false, error: 'unknown model' };
  if (downloading) return { ok: false, error: 'already downloading' };
  downloading = true;
  oomStopped = false; oomStoppedFor = null; // an explicit retry re-arms the brain
  try {
    // already complete? just select + boot it
    if (findInDirs(entry.file, entry.bytes) && (!entry.mmprojFile || findInDirs(entry.mmprojFile, entry.mmprojBytes))) {
      writeActiveId(modelId);
      void ensureServer().catch(() => {});
      return { ok: true };
    }
    await ensureServerBinary(); // small — fetch the engine before the big model
    emit({ type: 'state', modelId, state: 'downloading', progress: 0 });
    if (!findInDirs(entry.file)) await downloadTo(entry.url, path.join(llmDir(), entry.file), modelId);
    if (entry.mmprojUrl && entry.mmprojFile && !findInDirs(entry.mmprojFile)) {
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
  touchUse();
  return cloudChat({ ...p, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'no-key' });
}

// ---------- ipc ----------

export function registerLlmIpc(): void {
  ipcMain.handle('llm:catalog', () => CATALOG);
  ipcMain.handle('llm:status', () => ({
    models: CATALOG.map((c) => {
      const t = transient.get(c.id);
      const downloaded = !!findInDirs(c.file, c.bytes);
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
  ipcMain.handle('llm:getDirs', () => scanDirs().slice(1));
  ipcMain.handle('llm:browseDir', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Pick your models folder' });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    // remember it and rescan — any catalog GGUF inside becomes usable instantly
    const cur = (() => { try { return JSON.parse(fs.readFileSync(path.join(llmDir(), 'scan-dirs.json'), 'utf8')); } catch { return []; } })();
    const next = Array.from(new Set([...(Array.isArray(cur) ? cur : []), r.filePaths[0]]));
    fs.mkdirSync(llmDir(), { recursive: true });
    fs.writeFileSync(path.join(llmDir(), 'scan-dirs.json'), JSON.stringify(next, null, 2));
    return { ok: true, dirs: next };
  });
  ipcMain.handle('llm:addDir', (_e, dir: string) => {
    const clean = String(dir || '').trim();
    if (!clean) return { ok: false, error: 'empty path' };
    const cur = (() => { try { return JSON.parse(fs.readFileSync(path.join(llmDir(), 'scan-dirs.json'), 'utf8')); } catch { return []; } })();
    const next = Array.from(new Set([...(Array.isArray(cur) ? cur : []), clean]));
    fs.mkdirSync(llmDir(), { recursive: true });
    fs.writeFileSync(path.join(llmDir(), 'scan-dirs.json'), JSON.stringify(next, null, 2));
    return { ok: true, dirs: next };
  });
  ipcMain.handle('llm:select', async (_e, modelId: string) => {
    if (!findInDirs(CATALOG.find((c) => c.id === modelId)?.file)) return { ok: false, error: 'model not downloaded' };
    oomStopped = false; oomStoppedFor = null; // an explicit re-pick re-arms the brain
    writeActiveId(modelId);
    void ensureServer().catch(() => {});
    return { ok: true };
  });
  setLocalChat(localChat);
  // warm the local brain in the background — after a restart the first message
  // otherwise pays the whole model-load cost (tens of seconds on a cold disk).
  // No model downloaded → this quietly does nothing.
  setTimeout(() => {
    if (!oomStopped) void ensureServer().catch(() => { /* surfaced via state events */ });
  }, 1500);
}

/** call on app quit so llama-server doesn't linger */
export function shutdownLlm(): void {
  stopServer();
}
