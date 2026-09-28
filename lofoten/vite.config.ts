import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any subpath (GitHub Pages, Vercel, file server).
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
