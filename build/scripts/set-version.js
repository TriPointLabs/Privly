import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(new URL(import.meta.url)));
const root = resolve(__dirname, '../..');
const version = process.argv[2];
if (!version) { console.error('Usage: set-version.js <version>'); process.exit(1); }

const path = resolve(root, 'package.json');
const data = JSON.parse(readFileSync(path, 'utf8'));
data.version = version;
writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
console.log(`Updated package.json → ${version}`);
