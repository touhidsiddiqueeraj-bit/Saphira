import { ipcMain, net } from 'electron';

// Brain IPC: cloud = any OpenAI-compatible /chat/completions endpoint;
// local = the node-llama-cpp GGUF session (wired in desktop/llm.ts).
export type BrainChatPayload = {
  mode: 'cloud' | 'local';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  system: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  user: string;
  images?: string[];   // data URLs attached to the current user turn (vision)
};

type LocalChat = (p: BrainChatPayload) => Promise<string>;
let localChat: LocalChat | null = null;

/** desktop/llm.ts calls this when its session is ready. */
export function setLocalChat(fn: LocalChat): void { localChat = fn; }

export async function cloudChat(p: BrainChatPayload): Promise<string> {
  const base = (p.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  // vision turns use multipart content; plain text stays a plain string so
  // text-only endpoints never see an unfamiliar shape
  const userContent: any = p.images?.length
    ? [{ type: 'text', text: p.user }, ...p.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
    : p.user;
  const messages = [
    { role: 'system', content: p.system },
    ...p.history,
    { role: 'user', content: userContent },
  ];
  const call = (withJsonFormat: boolean) => net.fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {}),
    },
    body: JSON.stringify({
      model: p.model,
      messages,
      temperature: 0.9,
      max_tokens: 500,
      ...(withJsonFormat ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  // json_object is OpenAI-specific — quietly retry without it where unsupported
  let res = await call(true);
  if (res.status === 400) res = await call(false);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${t.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('empty reply');
  return text;
}

export function registerBrainIpc(): void {
  ipcMain.handle('brain:chat', async (_e, payload: BrainChatPayload) => {
    if (payload.mode === 'local') {
      if (!localChat) throw new Error('Local brain not ready — pick and download a model in Settings');
      return { text: await localChat(payload) };
    }
    return { text: await cloudChat(payload) };
  });
}
