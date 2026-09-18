import { ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { LlamaChatSession, Llama, LlamaModel, LlamaContext, ChatHistoryItem } from 'node-llama-cpp';
import { llmDir } from './modelStore.js';
import { setLocalChat, type BrainChatPayload } from './brain.js';

// Small instruct GGUFs that respect her JSON reply contract. Q4_K_M is the
// sweet spot: 3B ≈ 2 GB download / ~3 GB RAM, 1.5B ≈ 1 GB / ~2 GB RAM.
const CATALOG = [
  {
    id: 'qwen2.5-1.5b',
    label: 'Qwen2.5 1.5B — light (~1 GB)',
    file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    bytes: 986_000_000,
  },
  {
    id: 'qwen2.5-3b',
    label: 'Qwen2.5 3B — sharper (~2 GB)',
    file: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    bytes: 1_990_000_000,
    recommended: true,
  },
] as const;

type ModelState = 'not-downloaded' | 'downloading' | 'loading' | 'ready' | 'error';
const transient = new Map<string, { state: ModelState; progress?: number; error?: string }>();
const activeFile = () => path.join(llmDir(), 'active.json');

// node-llama-cpp is imported lazily — its native lib loads only when a local
// brain is actually needed.
type Nlc = typeof import('node-llama-cpp');
let llama: Llama | null = null;
let nlc: Nlc | null = null;
async function lib(): Promise<Nlc> {
  if (!nlc) nlc = await import('node-llama-cpp');
  return nlc;
}
let model: LlamaModel | null = null;
let context: LlamaContext | null = null;
let session: LlamaChatSession | null = null;
let activeId: string | null = null;
let loadSeq = 0;

function emit(e: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('llm:event', e); } catch { /* window gone */ }
  }
}

function fileFor(id: string): string | null {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) return null;
  const p = path.join(llmDir(), c.file);
  return fs.existsSync(p) ? p : null;
}

function readActiveId(): string | null {
  try { return JSON.parse(fs.readFileSync(activeFile(), 'utf8')).id ?? null; } catch { return null; }
}

function writeActiveId(id: string | null): void {
  fs.mkdirSync(llmDir(), { recursive: true });
  fs.writeFileSync(activeFile(), JSON.stringify({ id }));
}

async function ensureLoaded(): Promise<LlamaChatSession> {
  const want = readActiveId();
  if (session && activeId === want && want) return session;
  const file = fileFor(want ?? '');
  if (!file) throw new Error('No local model downloaded yet');
  const seq = ++loadSeq;
  transient.set(want!, { state: 'loading' });
  emit({ type: 'state', modelId: want, state: 'loading' });
  try {
    const { getLlama, LlamaChatSession: LCS, LlamaLogLevel } = await lib();
    if (!llama) llama = await getLlama({ logLevel: LlamaLogLevel.warn });
    model?.dispose?.();
    session = null;
    model = await llama.loadModel({ modelPath: file });
    context = await model.createContext({ contextSize: 4096 });
    session = new LCS({ contextSequence: context.getSequence() });
    activeId = want;
    if (loadSeq === seq) {
      transient.set(want!, { state: 'ready' });
      emit({ type: 'state', modelId: want, state: 'ready' });
    }
    return session;
  } catch (e: any) {
    transient.set(want!, { state: 'error', error: String(e?.message || e).slice(0, 200) });
    emit({ type: 'state', modelId: want, state: 'error', error: String(e?.message || e).slice(0, 200) });
    throw e;
  }
}

function toHistory(p: BrainChatPayload): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [{ type: 'system', text: p.system }];
  for (const h of p.history) {
    items.push(h.role === 'assistant' ? { type: 'model', response: [h.content] } : { type: 'user', text: h.content });
  }
  return items;
}

async function localChat(p: BrainChatPayload): Promise<string> {
  const s = await ensureLoaded();
  s.setChatHistory(toHistory(p));
  let out = '';
  try {
    out = await s.prompt(p.user, { maxTokens: 520, temperature: 0.9 });
  } catch (e) {
    throw new Error('Local brain failed: ' + String((e as any)?.message || e).slice(0, 160));
  }
  // small models sometimes wrap the JSON in chatter — one stern retry
  if (!out.includes('{')) {
    s.setChatHistory(toHistory(p));
    out = await s.prompt(p.user + '\n\nReply with ONLY the JSON object — nothing else.', { maxTokens: 520, temperature: 0.7 });
  }
  return out;
}

let downloading = false;
async function download(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const c = CATALOG.find((x) => x.id === modelId);
  if (!c) return { ok: false, error: 'unknown model' };
  if (downloading) return { ok: false, error: 'already downloading' };
  downloading = true;
  transient.set(modelId, { state: 'downloading', progress: 0 });
  emit({ type: 'state', modelId, state: 'downloading', progress: 0 });
  try {
    const { resolveModelFile } = await lib();
    await resolveModelFile(c.url, {
      directory: llmDir(),
      onProgress: (s: { totalSize: number; downloadedSize: number }) => {
        const p = s.totalSize > 0 ? s.downloadedSize / s.totalSize : 0;
        transient.set(modelId, { state: 'downloading', progress: p });
        emit({ type: 'progress', modelId, progress: p });
      },
    });
    transient.set(modelId, { state: 'ready' });
    emit({ type: 'state', modelId, state: 'ready' });
    // make her newly-downloaded brain active and warm it up
    writeActiveId(modelId);
    void ensureLoaded().catch(() => { /* surfaced on next status */ });
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

export function registerLlmIpc(): void {
  ipcMain.handle('llm:catalog', () => CATALOG);
  ipcMain.handle('llm:status', () => ({
    models: CATALOG.map((c) => {
      const t = transient.get(c.id);
      const exists = !!fileFor(c.id);
      const state: ModelState = t?.state === 'ready' ? 'ready'
        : t?.state === 'loading' ? 'loading'
        : t?.state === 'downloading' ? 'downloading'
        : t?.state === 'error' ? 'error'
        : exists ? 'ready' : 'not-downloaded';
      return { ...c, state, progress: t?.progress, error: t?.error };
    }),
    activeId: readActiveId(),
  }));
  ipcMain.handle('llm:download', (_e, modelId: string) => download(modelId));
  ipcMain.handle('llm:select', async (_e, modelId: string) => {
    if (!fileFor(modelId)) return { ok: false, error: 'model not downloaded' };
    writeActiveId(modelId);
    void ensureLoaded().catch(() => {});
    return { ok: true };
  });
  setLocalChat(localChat);
}
