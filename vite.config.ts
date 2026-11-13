import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/webview',
  base: './',
  build: {
    outDir: '../../dist/webview', emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'reader.js', assetFileNames: 'assets/[name]-[hash][extname]' } },
    target: 'chrome120', chunkSizeWarningLimit: 1600,
  },
});
