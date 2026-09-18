// Drop native binaries for other platforms before packaging one target.
// Usage: node scripts/prune-platform.mjs linux   (or `win`, `darwin`)
// Layout notes: onnxruntime-node/bin/<napi-vN>/<platform>/<arch>,
// @node-llama-cpp/<platform>-<arch>[-cuda|-vulkan]. Only the CPU default is
// kept; GPU/CUDA variants (and missing foreign-platform binaries) are fetched
// by getLlama() at runtime on first use.
import fs from 'node:fs';
import path from 'node:path';

const want = process.argv[2] || 'linux';
const wantOrt = want === 'win' ? 'win32' : want;
const nm = 'node_modules';
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); console.log('pruned', p); } catch {} };
const dirEntries = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

// onnxruntime-node/bin/napi-v{3,6}/{linux,win32,darwin}/<arch>
for (const napi of dirEntries(path.join(nm, 'onnxruntime-node', 'bin'))) {
  for (const plat of dirEntries(path.join(nm, 'onnxruntime-node', 'bin', napi))) {
    if (plat !== wantOrt) rm(path.join(nm, 'onnxruntime-node', 'bin', napi, plat));
  }
}

// @node-llama-cpp: keep only the plain CPU build for the target platform
for (const d of dirEntries(path.join(nm, '@node-llama-cpp'))) {
  const isPlain = d === `${want}-x64` || d === `${want}-arm64`;
  if (!isPlain) rm(path.join(nm, '@node-llama-cpp', d));
}

console.log(`pruned node_modules to ${want} natives`);
