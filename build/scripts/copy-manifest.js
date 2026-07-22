import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const browserIndex = process.argv.indexOf('--browser');
if (browserIndex === -1 || !process.argv[browserIndex + 1]) {
  console.error('Usage: copy-manifest.js --browser <chrome|firefox>');
  process.exit(1);
}

const browser = process.argv[browserIndex + 1];
if (browser !== 'chrome' && browser !== 'firefox') {
  console.error(`Unknown browser: ${browser}. Must be chrome or firefox.`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, `src/manifests/manifest.${browser}.json`), 'utf8'));
manifest.version = version;

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Copied manifest.${browser}.json -> dist/manifest.json (version: ${version})`);
