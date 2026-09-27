import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (GitHub Pages, Vercel, a folder).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
});
