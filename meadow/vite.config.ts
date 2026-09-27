import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (Vercel, a folder, a preview).
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
  server: { host: true },
});
