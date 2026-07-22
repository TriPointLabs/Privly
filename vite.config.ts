import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { reloadPlugin } from './build/reloadPlugin';

export default defineConfig({
  root: resolve(__dirname, 'src'),
  envDir: resolve(__dirname, '.'),
  base: './',
  publicDir: resolve(__dirname, 'public'),
  build: {
    target: ['chrome126', 'firefox128'],
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background/index.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  plugins: [tailwindcss(), svelte(), reloadPlugin()],
});
