import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBin } from './runner';
import type { ProjectProfile } from './types';

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.roundtable', 'docs', 'test', 'tests', '__tests__']);

export function emptyProfile(root: string | undefined): ProjectProfile {
  return {
    root,
    git: false,
    packageManager: undefined,
    node: false,
    typescript: false,
    tsconfig: undefined,
    eslint: false,
    testRunner: undefined,
    testCommand: undefined,
    scripts: {},
    srcDirs: [],
    tools: { tsc: false, eslint: false, depcruise: false, gitleaks: false },
    files: { agentsMd: false, claudeMd: false, architectureYml: false, adrDir: false, depcruiseConfig: false },
  };
}

/** Synchronous, cheap detection of what the workspace is. */
export function detectProject(root: string | undefined): ProjectProfile {
  const profile = emptyProfile(root);
  if (!root) return profile;
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));

  profile.git = exists('.git');
  profile.files = {
    agentsMd: exists('AGENTS.md'),
    claudeMd: exists('CLAUDE.md'),
    architectureYml: exists('docs/architecture.yml'),
    adrDir: exists('docs/adr'),
    depcruiseConfig: ['.dependency-cruiser.cjs', '.dependency-cruiser.js', '.dependency-cruiser.json', '.dependency-cruiser.mjs'].some(exists),
  };

  let pkg: Record<string, unknown> | undefined;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    pkg = undefined;
  }
  if (pkg) {
    profile.node = true;
    profile.scripts = (pkg.scripts as Record<string, string>) ?? {};
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
    profile.packageManager = exists('pnpm-lock.yaml')
      ? 'pnpm'
      : exists('yarn.lock')
        ? 'yarn'
        : exists('bun.lockb') || exists('bun.lock')
          ? 'bun'
          : 'npm';
    profile.typescript = 'typescript' in deps || exists('tsconfig.json');
    profile.tsconfig = exists('tsconfig.json') ? 'tsconfig.json' : undefined;
    profile.eslint =
      'eslint' in deps ||
      ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs'].some(exists);
    profile.testRunner = 'vitest' in deps ? 'vitest' : 'jest' in deps ? 'jest' : 'mocha' in deps ? 'mocha' : undefined;
    const testScript = profile.scripts.test;
    if (testScript && !/no test specified/.test(testScript)) {
      profile.testCommand = `${profile.packageManager} test`;
    } else if (profile.testRunner === 'vitest') {
      profile.testCommand = 'vitest run';
    } else if (profile.testRunner === 'jest') {
      profile.testCommand = 'jest';
    }
  }

  profile.srcDirs = findSourceDirs(root);
  profile.tools = {
    tsc: !!resolveBin(root, 'tsc'),
    eslint: !!resolveBin(root, 'eslint'),
    depcruise: !!resolveBin(root, 'depcruise'),
    gitleaks: !!resolveBin(root, 'gitleaks'),
  };
  return profile;
}

/** `src/*` subdirectories when a src folder exists, else top-level code folders. */
function findSourceDirs(root: string): string[] {
  const list = (dir: string) => {
    try {
      return fs
        .readdirSync(path.join(root, dir), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !IGNORED_DIRS.has(d.name))
        .map((d) => (dir ? `${dir}/${d.name}` : d.name));
    } catch {
      return [];
    }
  };
  if (fs.existsSync(path.join(root, 'src'))) {
    const inner = list('src');
    return inner.length > 0 ? inner : ['src'];
  }
  return list('').filter((d) => hasCode(path.join(root, d)));
}

function hasCode(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(f));
  } catch {
    return false;
  }
}

/** One-line description for the UI. */
export function describeProfile(p: ProjectProfile): string {
  if (!p.root) return 'No folder open — guardrails need a workspace.';
  const parts: string[] = [];
  parts.push(p.typescript ? 'TypeScript' : p.node ? 'JavaScript' : 'unknown stack');
  if (p.packageManager) parts.push(p.packageManager);
  if (p.testRunner) parts.push(p.testRunner);
  if (p.eslint) parts.push('eslint');
  parts.push(p.git ? 'git' : 'no git');
  return parts.join(' · ');
}
