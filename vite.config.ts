// Vite bygger och serverar skalet (web/). I dev körs Vite som middleware inne i server/main.ts,
// med HMR-websocketen på en egen port (Config.hmrPort) så att den aldrig krockar med /ws eller apparnas uppgraderingar.
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  publicDir: false,
  appType: 'spa',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2023',
  },
});
