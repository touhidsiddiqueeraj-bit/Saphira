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
  const napiDir = path.join(nm, 'onnxruntime-node', 'bin', napi);
  for (const plat of dirEntries(napiDir)) {
    if (plat !== wantOrt) { rm(path.join(napiDir, plat)); continue; }
    // strip hardware-provider add-ons inside the KEPT platform dir.
    // onnxruntime-node's postinstall fetches libonnxruntime_providers_cuda.so
    // (343 MB!) and _providers_tensorrt.so; Saphira runs whisper via the CPU
    // provider only, so these are dead weight in every installer.
    for (const arch of dirEntries(path.join(napiDir, plat))) {
      for (const f of dirEntries(path.join(napiDir, plat, arch))) {
        if (/^libonnxruntime_providers_/i.test(f) || /^onnxruntime_providers_/i.test(f)) {
          rm(path.join(napiDir, plat, arch, f));
        }
      }
    }
  }
}

// @node-llama-cpp: keep only the plain CPU build for the target platform
for (const d of dirEntries(path.join(nm, '@node-llama-cpp'))) {
  const isPlain = d === `${want}-x64` || d === `${want}-arm64`;
  if (!isPlain) rm(path.join(nm, '@node-llama-cpp', d));
}

console.log(`pruned node_modules to ${want} natives (providers stripped)`);
