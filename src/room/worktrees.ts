import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout.trim();
}

/**
 * Returns a git worktree of `workspaceDir` dedicated to one agent, creating it
 * on first use. Worktrees live under `storageDir` (extension storage), not in
 * the workspace. Throws when the workspace is not a git repository.
 */
export async function ensureWorktree(workspaceDir: string, storageDir: string, agentId: string): Promise<string> {
  const root = await git(workspaceDir, 'rev-parse', '--show-toplevel');
  const key = createHash('sha1').update(root).digest('hex').slice(0, 12);
  const dir = path.join(storageDir, 'worktrees', key, agentId);
  try {
    await fs.access(path.join(dir, '.git'));
    return dir;
  } catch {
    // not created yet
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(root, 'worktree', 'add', '--detach', dir);
  // Share installed dependencies so tooling (tsc, eslint, tests) works in the worktree.
  const modules = path.join(root, 'node_modules');
  try {
    await fs.access(modules);
    await fs.symlink(modules, path.join(dir, 'node_modules'), 'dir');
  } catch {
    // no node_modules in the project, or the link already exists
  }
  return dir;
}
