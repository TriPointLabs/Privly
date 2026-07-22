import type { Plugin } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __dirname = dirname(fileURLToPath(new URL(import.meta.url)));
const root = resolve(__dirname, '..');
const browser = process.env.BROWSER === 'firefox' ? 'firefox' : 'chrome';

// Derived from the manifest key - matches the published Chrome Web Store ID
const CHROME_EXTENSION_ID = 'clkkekkbklngnoddimnmelodikonhaig';

// Derived from the manifest key - browser_specific_settings.gecko.id
const FIREFOX_EXTENSION_ID = 'privly@addons.tripointlabs.com';

function copyManifest() {
  mkdirSync(resolve(root, 'dist'), { recursive: true });
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(root, `src/manifests/manifest.${browser}.json`), 'utf8'));
  manifest.version = version;
  writeFileSync(resolve(root, 'dist/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function prepareChromeProfile() {
  const defaultDir = resolve(root, '.chrome-profile/Default');
  const prefsPath = resolve(defaultDir, 'Preferences');
  mkdirSync(defaultDir, { recursive: true });

  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(readFileSync(prefsPath, 'utf8')); } catch {}

  const ext = (prefs.extensions ??= {}) as Record<string, unknown>;
  const pinned = (ext.pinned_extensions as string[] | undefined) ?? [];
  if (!pinned.includes(CHROME_EXTENSION_ID)) pinned.push(CHROME_EXTENSION_ID);
  ext.pinned_extensions = pinned;

  writeFileSync(prefsPath, JSON.stringify(prefs));
}

function launchWebExt() {
  const args = browser === 'firefox'
    ? ['web-ext', 'run', '--target', 'firefox-desktop',
       '--firefox-profile', resolve(root, '.firefox-profile'),
       '--keep-profile-changes', '--profile-create-if-missing',
       '--config', 'web-ext-config.mjs']
    : ['web-ext', 'run', '--target', 'chromium',
       '--chromium-profile', resolve(root, '.chrome-profile'),
       '--keep-profile-changes', '--profile-create-if-missing',
       '--start-url', 'about:newtab', '--config', 'web-ext-config.mjs'];

  const child = spawn('npx', args, { stdio: 'inherit', cwd: root });
  child.on('close', () => process.exit(0));
}

export function reloadPlugin(): Plugin {
  let wss: WebSocketServer | null = null;
  const clients = new Set<WebSocket>();
  let watchMode = false;
  let webExtLaunched = false;

  return {
    name: 'privly-reload',
    apply: 'build',

    buildStart() {
      watchMode = this.meta.watchMode;
      if (!watchMode) return;

      this.addWatchFile(resolve(root, `src/manifests/manifest.${browser}.json`));

      if (wss) return; // already started on a previous rebuild

      const server = new WebSocketServer({ port: 8765 });
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn('[reload-plugin] Port 8765 already in use - skipping WebSocket server');
        } else {
          console.error('[reload-plugin] WebSocket error:', err);
        }
      });
      server.on('listening', () => {
        console.log('[reload-plugin] WebSocket server listening on ws://localhost:8765');
      });
      server.on('connection', (ws) => {
        clients.add(ws);
        ws.on('close', () => clients.delete(ws));
      });
      wss = server;
    },

    writeBundle() {
      if (!watchMode) return;

      copyManifest();
      console.log(`[reload-plugin] Copied manifest.${browser}.json -> dist/manifest.json`);

      if (!webExtLaunched) {
        webExtLaunched = true;
        if (browser === 'chrome') prepareChromeProfile();
        launchWebExt();
        return; // web-ext will load fresh - no reload broadcast needed
      }

      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send('reload');
        }
      }
    },
  };
}
