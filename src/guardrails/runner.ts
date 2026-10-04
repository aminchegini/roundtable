import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RunResult {
  code: number;
  /** Combined stdout + stderr, capped. */
  output: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutput?: number;
}

export interface Runner {
  run(file: string, args: string[], options: RunOptions): Promise<RunResult>;
  /** Absolute path of a project-local CLI (node_modules/.bin) or a PATH lookup, undefined when missing. */
  resolveBin(root: string, name: string): string | undefined;
}

/** Runs gate commands one at a time so parallel hooks do not fight over CPU and output. */
export class ProcessRunner implements Runner {
  private queue: Promise<unknown> = Promise.resolve();

  run(file: string, args: string[], options: RunOptions): Promise<RunResult> {
    const job = this.queue.then(() => exec(file, args, options));
    this.queue = job.catch(() => undefined);
    return job;
  }

  resolveBin(root: string, name: string): string | undefined {
    return resolveBin(root, name);
  }
}

export function resolveBin(root: string, name: string): string | undefined {
  const local = path.join(root, 'node_modules', '.bin', name);
  if (fs.existsSync(local)) return local;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function exec(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  const maxOutput = options.maxOutput ?? 6000;
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const combined = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
        const output = combined.length > maxOutput ? `${combined.slice(0, maxOutput)}\n… (${combined.length - maxOutput} more chars)` : combined;
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const timedOut = !!err?.killed;
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, output: err && !combined ? err.message : output, timedOut });
      },
    );
  });
}

/** Tail of a command output, for Stop reasons. */
export function tail(text: string, lines = 40): string {
  const all = text.split('\n');
  return all.length > lines ? `…\n${all.slice(-lines).join('\n')}` : text;
}
