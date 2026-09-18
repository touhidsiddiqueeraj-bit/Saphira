import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

// All downloaded AI payloads live under <userData>/models — nothing ships in
// the installer, everything is fetched on first use with progress surfaced.
export function modelsRoot(): string {
  const root = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(root, { recursive: true });
  return root;
}
export function llmDir(): string { return path.join(modelsRoot(), 'llm'); }
export function ttsCacheDir(): string { return path.join(modelsRoot(), 'tts'); }
export function sttCacheDir(): string { return path.join(modelsRoot(), 'stt'); }

// Phase 3 fills this in (llm:catalog / llm:download / llm:select);
// Phase 4 adds tts:* and Phase 5 adds stt:* on the same pattern.
export function registerModelIpc(): void {
  ipcMain.handle('models:ping', () => modelsRoot());
}
