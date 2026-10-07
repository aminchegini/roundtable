// Recorded provider transcripts are the most likely way a token or a home
// path lands in git. This runs in CI and from the pre-commit hook; it does not
// trust the recorder's scrubber.
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = 'test/fixtures';
const PATTERNS = [
  [/\/Users\/[^/\s"']+/, 'macOS home path'],
  [/\/home\/[^/\s"']+/, 'Linux home path'],
  [/[A-Z]:\\\\Users\\\\/, 'Windows home path'],
  [/sk-[A-Za-z0-9_-]{16,}/, 'OpenAI/Anthropic-style key'],
  [/sk-ant-[A-Za-z0-9_-]{8,}/, 'Anthropic key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/ya29\.[A-Za-z0-9_-]{20,}/, 'Google OAuth token'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/, 'bearer token'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'email address'],
];

let problems = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.jsonl')) scan(file);
  }
}
function scan(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [re, label] of PATTERNS) {
      const m = re.exec(line);
      if (m) {
        problems++;
        console.error(`${file}:${i + 1}: ${label}: ${m[0].slice(0, 40)}…`);
      }
    }
  });
}
walk(ROOT);
if (problems) {
  console.error(`\n${problems} suspicious value(s) in fixtures. Re-record with npm run fixtures:record, or scrub by hand.`);
  process.exit(1);
}
console.log('fixtures clean');
