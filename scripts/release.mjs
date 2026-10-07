// Cut a release: bump package.json, move CHANGELOG "Unreleased" under the
// version, commit and tag. Pushing the tag runs .github/workflows/release.yml.
// Usage: node scripts/release.mjs <version> [--dry-run]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const version = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: npm run release -- <semver> [--dry-run]');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) {
  console.error('working tree not clean; commit or discard first');
  process.exit(1);
}

const pkgPath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const previous = pkg.version;
pkg.version = version;

const changelogPath = 'CHANGELOG.md';
let changelog = fs.readFileSync(changelogPath, 'utf8');
const today = new Date().toISOString().slice(0, 10);
const heading = `## ${version} — ${today}`;
if (/^## Unreleased\s*$/m.test(changelog)) {
  changelog = changelog.replace(/^## Unreleased\s*$/m, `## Unreleased\n\n_Nothing yet._\n\n${heading}`);
} else {
  changelog = changelog.replace(/^# Changelog\s*\n/, `# Changelog\n\n## Unreleased\n\n_Nothing yet._\n\n${heading}\n\n- (describe the change)\n`);
}

console.log(`${previous} → ${version}${dryRun ? ' (dry run)' : ''}`);
if (dryRun) {
  console.log(changelog.split('\n').slice(0, 20).join('\n'));
  process.exit(0);
}

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync(changelogPath, changelog);
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { stdio: 'inherit' });
git('add', pkgPath, 'package-lock.json', changelogPath);
git('commit', '-q', '-m', `Release ${version}`);
git('tag', '-a', `v${version}`, '-m', `Roundtable ${version}`);
console.log(`committed and tagged v${version}. Push with: git push && git push origin v${version}`);
