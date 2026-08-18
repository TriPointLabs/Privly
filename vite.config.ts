import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { reloadPlugin } from './build/reloadPlugin.ts';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  envDir: resolve(import.meta.dirname, '.'),
  base: './',
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    target: ['chrome126', 'firefox128'],
    // Vite emits <link rel="modulepreload" crossorigin> for chunks shared
    // between the popup and the service worker (currently tools/db.ts). On a
    // chrome-extension:// page the preload goes out in CORS mode while the
    // real module load does not, so the two requests key differently, Chrome
    // discards the preloaded copy ("cross-world extension resource mismatch")
    // and fetches the chunk twice. Preloading buys nothing here anyway --
    // extension assets are local, so there is no network round trip to
    // overlap. Disabling it also drops Vite's modulepreload polyfill, which is
    // dead weight given the Chrome 126 / Firefox 128 targets both support
    // modulepreload natively.
    modulePreload: false,
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup/index.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
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
