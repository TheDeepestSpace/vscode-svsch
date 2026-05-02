import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/webview'),
  server: {
    port: 5176,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, 'media'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/webview/index.html'),
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: 'webview.[ext]'
      }
    }
  }
});
