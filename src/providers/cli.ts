import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Finds vendor CLIs the user installed. Roundtable ships no vendor binaries,
 * so this is the only way an agent runtime is reached.
 *
 * Order: explicit setting → well-known install dirs → PATH → the login shell's
 * PATH (VS Code launched from the Dock or a launcher often has a short PATH).
 */
export interface CliLookup {
  /** Candidate executable names, first match wins (e.g. ['agent', 'cursor-agent']). */
  names: string[];
  /** User-configured path; returned as-is when it exists. */
  configured?: string;
}

const home = os.homedir();
const WELL_KNOWN_DIRS = [
  path.join(home, '.local', 'bin'),
  path.join(home, '.npm-global', 'bin'),
  path.join(home, '.bun', 'bin'),
  path.join(home, 'Library', 'pnpm'),
  path.join(home, '.local', 'share', 'pnpm'),
  path.join(home, '.volta', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
];

let loginPathDirs: string[] | undefined;
const found = new Map<string, string | undefined>();

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** PATH of the user's login shell, read once; empty on Windows or failure. */
export function loginShellPath(): string[] {
  if (loginPathDirs) return loginPathDirs;
  loginPathDirs = [];
  if (process.platform === 'win32') return loginPathDirs;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-lic', 'echo __RT_PATH__=$PATH'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').find((l) => l.startsWith('__RT_PATH__='));
    if (line) loginPathDirs = line.slice('__RT_PATH__='.length).split(path.delimiter).filter(Boolean);
  } catch {
    // interactive shell unavailable (CI, restricted env); fall back to what we have
  }
  return loginPathDirs;
}

export function findCli(lookup: CliLookup): string | undefined {
  if (lookup.configured?.trim()) {
    const p = lookup.configured.trim();
    return executable(p) ? p : undefined;
  }
  const key = lookup.names.join('|');
  if (found.has(key)) return found.get(key);
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...WELL_KNOWN_DIRS, ...loginShellPath()].filter(Boolean);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  let result: string | undefined;
  outer: for (const name of lookup.names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (executable(candidate)) {
          result = candidate;
          break outer;
        }
      }
    }
  }
  found.set(key, result);
  return result;
}

/** Forget cached lookups (Refresh Providers, after an install). */
export function resetCliCache(): void {
  found.clear();
  loginPathDirs = undefined;
}

/** Test hook: override the directories searched. */
export function _setCliSearchDirsForTests(dirs: string[] | undefined): void {
  if (dirs) {
    loginPathDirs = dirs;
    WELL_KNOWN_DIRS.length = 0;
  }
  found.clear();
}
