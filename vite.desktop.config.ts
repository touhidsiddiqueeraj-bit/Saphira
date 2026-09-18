import { defineConfig } from 'vite';

// Desktop renderer build — Chromium-only: the iPad legacy pipeline lives in the
// lite repo; here we ship modern JS at full fidelity.
export default defineConfig({
  server: { host: true, port: 5174 },
  base: './',
  define: { __SAPHIRA_DESKTOP__: JSON.stringify(true) },
  build: {
    outDir: 'dist-desktop',
    target: 'chrome120',
    cssTarget: 'chrome100',
    sourcemap: false,
  },
});
