import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { Runner, RunResult } from '../runner';
import { relativeTo } from '../runtime';
import type { HookCtx } from '../types';

export const READ_ONLY_DENY = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];

/** Shell commands that only read; allowed while an agent is locked out of edits. */
export const READONLY_COMMANDS = [
  '^git (status|diff|log|show|blame|branch|rev-parse|ls-files)\\b',
  '^(ls|cat|head|tail|wc|find|grep|rg|tree|pwd|echo|which|env)\\b',
  '^(npm|pnpm|yarn|bun) (test|run test|run lint|run typecheck|ls|why|outdated)\\b',
  '^(npx |pnpm exec |yarn )?(tsc|eslint|vitest|jest|depcruise)\\b',
  '^node --version|^node -v',
];

export function matchesAny(patterns: string[], text: string): string | undefined {
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) return p;
    } catch {
      // ignore bad user regex
    }
  }
  return undefined;
}

export function globMatcher(globs: string[]): (rel: string) => boolean {
  if (globs.length === 0) return () => false;
  const match = picomatch(globs, { dot: true });
  return (rel) => match(rel) || match(path.basename(rel));
}

/** Relative path of a tool target from the project root, for glob matching. */
export function projectRelative(ctx: HookCtx, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.join(ctx.cwd, file);
  // Worktrees mirror the project layout, so paths inside them map 1:1.
  const base = abs.startsWith(ctx.cwd) ? ctx.cwd : ctx.root;
  return relativeTo(base, abs);
}

export const TS_FILE = /\.(ts|tsx|mts|cts)$/;
export const JS_TS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function editedMatching(ctx: HookCtx, pattern: RegExp): string[] {
  return [...ctx.turn.editedFiles].filter((f) => pattern.test(f));
}

/** Split a command string and resolve its first token against project-local bins. */
export function resolveCommand(runner: Runner, root: string, command: string): { file: string; args: string[] } {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) ?? [];
  const [first = '', ...rest] = tokens;
  if (first === 'npx' || first === 'pnpm' && rest[0] === 'exec') {
    const [bin = '', ...args] = first === 'npx' ? rest : rest.slice(1);
    return { file: runner.resolveBin(root, bin) ?? bin, args };
  }
  return { file: runner.resolveBin(root, first) ?? first, args: rest };
}

export async function runCommand(ctx: HookCtx, command: string, extraArgs: string[] = [], timeoutMs?: number): Promise<RunResult> {
  const { file, args } = resolveCommand(ctx.runner, ctx.root, command);
  return ctx.runner.run(file, [...args, ...extraArgs], { cwd: ctx.cwd, timeoutMs });
}

/** True when at least `seconds` passed since this key last ran in the current turn. */
export function throttle(ctx: HookCtx, key: string, seconds: number): boolean {
  const last = ctx.turn.lastRun.get(key) ?? 0;
  const now = Date.now();
  if (now - last < seconds * 1000) return false;
  ctx.turn.lastRun.set(key, now);
  return true;
}

export function readFileCapped(file: string, max = 1024 * 1024): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > max) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function listLines(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}
