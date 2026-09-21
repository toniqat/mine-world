import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built index.html also works from Electron's file:// loader.
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: ['..', '../..'] },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
});
