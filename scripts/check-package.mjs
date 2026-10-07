// Gate on what goes into the .vsix.
//
// 1. The exact file list vsce would package must match the committed
//    package-manifest.txt, so any change to what ships is reviewed in the PR.
// 2. Nothing from a denylist (sources, tests, maps, env files, vendor binaries)
//    may be inside.
// 3. When a built .vsix is present, it must be under the size cap.
//
// Usage: node scripts/check-package.mjs [--update]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const MANIFEST = 'package-manifest.txt';
const SIZE_CAP_MB = 25;
const DENY = [
  /^src\//,
  /^test\//,
  /^scripts\//,
  /^webview\//,
  /^docs\//,
  /\.map$/,
  /(^|\/)\.env/,
  /^node_modules\//,
  /^dist\/e2e/,
  /claude-agent-sdk-(darwin|linux|win32)/,
  /@openai\/codex-(darwin|linux|win32)/,
  /copilot-sdk-(darwin|linux|win32)/,
  /\.vsix$/,
];
const REQUIRED = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'DISCLAIMER.md', 'media/icon.png', 'media/icon.svg', 'dist/extension.js', 'dist/webview/main.js', 'dist/webview/main.css', 'dist/vendor/claude.mjs', 'dist/vendor/codex.mjs', 'dist/vendor/copilot.mjs'];
const update = process.argv.includes('--update');

const raw = execFileSync('npx', ['vsce', 'ls', '--no-dependencies'], { encoding: 'utf8' });
const actual = raw
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('Executing') && !l.startsWith('npm ') && !l.startsWith('>'))
  .sort();

let failed = false;
const denied = actual.filter((f) => DENY.some((re) => re.test(f)));
if (denied.length > 0) {
  console.error('Files that must not ship:');
  for (const f of denied) console.error(`  ${f}`);
  failed = true;
}
const missing = REQUIRED.filter((f) => !actual.includes(f));
if (missing.length > 0) {
  console.error('Required files missing from the package (run npm run build?):');
  for (const f of missing) console.error(`  ${f}`);
  failed = true;
}

if (update) {
  fs.writeFileSync(MANIFEST, actual.join('\n') + '\n');
  console.log(`${MANIFEST}: ${actual.length} files`);
} else {
  const expected = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).sort() : [];
  const added = actual.filter((f) => !expected.includes(f));
  const removed = expected.filter((f) => !actual.includes(f));
  if (added.length > 0 || removed.length > 0) {
    for (const f of added) console.error(`+ ${f}`);
    for (const f of removed) console.error(`- ${f}`);
    console.error(`\n${added.length} added, ${removed.length} removed. If intended: npm run check:package -- --update and commit ${MANIFEST}.`);
    failed = true;
  } else {
    console.log(`package manifest OK (${actual.length} files)`);
  }
}

const vsix = fs.readdirSync('.').find((f) => f.endsWith('.vsix'));
if (vsix) {
  const mb = fs.statSync(vsix).size / 1024 / 1024;
  console.log(`${vsix}: ${mb.toFixed(1)} MB (cap ${SIZE_CAP_MB} MB)`);
  if (mb >= SIZE_CAP_MB) {
    console.error('vsix over the size cap');
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
