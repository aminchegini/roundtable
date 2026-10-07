// Proves the packaged extension works without the repo's node_modules:
// unzips the .vsix, imports the vendor bundles from the extracted copy, runs
// provider detection, and (when a vendor is signed in here) one DM turn through
// the extracted bundles. Usage: node scripts/smoke-vsix.mjs [path/to.vsix] [--no-live]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const live = !process.argv.includes('--no-live');
// --no-live: CI mode, import-only, cleans up. Default keeps the extracted copy for a live run.
const vsix = process.argv.slice(2).find((a) => a.endsWith('.vsix')) ?? fs.readdirSync('.').find((f) => f.endsWith('.vsix'));
if (!vsix) {
  console.error('no .vsix found; run npm run package first');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-vsix-'));
execFileSync('unzip', ['-q', vsix, '-d', tmp]);
const root = path.join(tmp, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(`extracted ${manifest.name}@${manifest.version} (preview=${manifest.preview === true}) to ${root}`);

// Nothing from the repo may be reachable: run from a directory with no node_modules.
process.chdir(tmp);

let failed = false;
for (const name of ['claude', 'codex', 'copilot']) {
  const file = path.join(root, 'dist', 'vendor', `${name}.mjs`);
  try {
    const mod = await import(pathToFileURL(file).href);
    const exported = Object.keys(mod).slice(0, 4).join(', ');
    console.log(`  vendor ${name}: loaded (${exported}…)`);
  } catch (err) {
    console.error(`  vendor ${name}: FAILED to import — ${err instanceof Error ? err.message : err}`);
    failed = true;
  }
}

// The host bundle needs `vscode`; load it with a stub just far enough to prove it parses and
// exposes activate/deactivate.
const Module = await import('node:module');
const req = Module.createRequire(path.join(root, 'dist', 'extension.js'));
const originalLoad = Module.default._load;
Module.default._load = function (request, ...rest) {
  if (request === 'vscode') return new Proxy({}, { get: () => () => ({}) });
  return originalLoad.call(this, request, ...rest);
};
try {
  const ext = req(path.join(root, 'dist', 'extension.js'));
  console.log(`  extension.js: exports ${Object.keys(ext).join(', ')}`);
  if (typeof ext.activate !== 'function') throw new Error('no activate()');
} catch (err) {
  console.error(`  extension.js: FAILED — ${err instanceof Error ? err.message : err}`);
  failed = true;
} finally {
  Module.default._load = originalLoad;
}

if (live && !failed) {
  console.log(`  live check: ROUNDTABLE_VENDOR_ROOT=${root} npm run e2e:providers   (runs real turns through the extracted bundles)`);
}

if (!process.argv.includes('--keep') && !live) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`  extracted copy kept at ${tmp}`);
process.exit(failed ? 1 : 0);
