import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBin } from '../guardrails/runner';
import { buildRolePrompt } from '../room/SdkAgentSession';
import type { AgentConfig, Tokens } from '../shared/protocol';
import type { SessionContext } from './types';

export function home(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

export function exists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function findBin(...names: string[]): string | undefined {
  for (const name of names) {
    const found = resolveBin(process.cwd(), name) ?? [home('.local', 'bin', name)].find(exists);
    if (found) return found;
  }
  return undefined;
}

/**
 * Role prompt + guardrails + text protocol for providers without an SDK
 * system-prompt hook. Sent as the first user message of a new session.
 */
export async function buildFullPrompt(agent: AgentConfig, roster: AgentConfig[], cwd: string | undefined, ctx: SessionContext): Promise<string> {
  const parts = [buildRolePrompt(agent, roster, 'reply with exactly the single word PASS')];
  if (cwd && ctx.guardrails) {
    const extra = await ctx.guardrails.buildPrompt(agent, roster, cwd);
    if (extra) parts.push(extra);
    const protocol = ctx.guardrails.textProtocolPrompt(agent);
    if (protocol) parts.push(`## Room protocol\n${protocol}`);
  }
  return parts.join('\n\n');
}

/** First message of a fresh session: instructions, then the room digest. */
export function primedInput(instructions: string, digest: string): string {
  return `<instructions>\n${instructions}\n</instructions>\n\nThe room conversation so far, which you are now replying to:\n\n${digest}`;
}

export interface SpawnJsonlOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  stdin?: string;
  onLine(event: Record<string, unknown>): void;
  /** Non-JSON stderr/stdout lines. */
  onText?(line: string): void;
}

export interface SpawnResult {
  code: number | null;
  aborted: boolean;
  stderr: string;
}

/** Run a CLI that streams newline-delimited JSON and feed each event to `onLine`. */
export function spawnJsonl(file: string, args: string[], options: SpawnJsonlOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: cleanEnv(options.env ?? process.env),
      stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let aborted = false;
    let stderr = '';
    let buffer = '';
    const handleChunk = (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) emit(line);
      }
    };
    const emit = (line: string) => {
      if (line.startsWith('{')) {
        try {
          options.onLine(JSON.parse(line) as Record<string, unknown>);
          return;
        } catch {
          // fall through to text
        }
      }
      options.onText?.(line);
    };
    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
    });
    child.on('close', (code) => {
      if (buffer.trim()) emit(buffer.trim());
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, aborted, stderr: stderr.trim() });
    });
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    }
  });
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export function addTokens(total: Tokens, input: number | undefined, output: number | undefined): Tokens {
  return { input: total.input + (input ?? 0), output: total.output + (output ?? 0) };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Paths a tool call touches, from the common argument names vendors use. */
export function editedPathsFrom(args: unknown): string[] {
  const obj = (args ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['file_path', 'path', 'filePath', 'target_file', 'notebook_path']) {
    const v = obj[key];
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

export const WRITE_TOOL = /write|edit|replace|create|patch|apply|delete|move|rename/i;
