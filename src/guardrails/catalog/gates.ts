import * as path from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { tail } from '../runner';
import { MUTATING_TOOLS, bashCommand, deny, feedback, toolFilePath, toolWrittenText, type GuardrailDef, type HookCtx } from '../types';
import {
  JS_TS_FILE,
  TS_FILE,
  editedMatching,
  globMatcher,
  matchesAny,
  projectRelative,
  readFileCapped,
  runCommand,
  throttle,
} from './shared';

// ---------------------------------------------------------------- bash-safety

interface BashSafetyConfig {
  allowInstalls: boolean;
  allowForcePush: boolean;
  extraDeny: string[];
  allowlistOnly: boolean;
  allowlist: string[];
}

const DANGEROUS: Array<[string, string]> = [
  ['git push[^|&;]*(\\s--force\\b|\\s-f\\b|\\s--force-with-lease\\b)', 'force push'],
  ['\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\\s+(/|~|\\$HOME|\\.\\.|\\*)', 'recursive delete outside the project'],
  ['\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(ba|z|da)?sh\\b', 'piping a download into a shell'],
  ['(^|[;&|]\\s*)sudo\\b', 'sudo'],
  ['\\bchmod\\s+(-R\\s+)?[0-7]*777\\b', 'world-writable chmod'],
  ['\\bgit\\s+(reset\\s+--hard|clean\\s+-[a-z]*f|checkout\\s+--\\s+\\.)', 'discarding working-tree changes'],
  ['\\bmkfs\\b|\\bdd\\s+if=|>\\s*/dev/sd', 'disk-level destruction'],
  [':\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:', 'fork bomb'],
];

const INSTALL = '^(npm|pnpm|yarn|bun)\\s+(i|install|add|remove|uninstall|rm)\\b|\\bpip3?\\s+install\\b|\\bbrew\\s+install\\b';

export const bashSafety: GuardrailDef<BashSafetyConfig> = {
  id: 'bash-safety',
  title: 'Shell safety',
  summary: 'Blocks force pushes, recursive deletes outside the project, curl-into-shell, sudo, and other destructive commands.',
  layer: 'gate',
  fields: [
    { key: 'allowInstalls', label: 'Allow package installs', type: 'boolean', help: 'npm/pnpm/yarn/bun add or remove' },
    { key: 'allowForcePush', label: 'Allow force push', type: 'boolean' },
    { key: 'extraDeny', label: 'Extra denied patterns (regex)', type: 'list' },
    { key: 'allowlistOnly', label: 'Allowlist only', type: 'boolean', help: 'Deny every command that matches no allowlist pattern' },
    { key: 'allowlist', label: 'Allowlist patterns (regex)', type: 'list' },
  ],
  appliesTo: () => true,
  defaults: () => ({ allowInstalls: false, allowForcePush: false, extraDeny: [], allowlistOnly: false, allowlist: [] }),
  status: () => 'ready',
  hooks: (ctx) => ({
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const cmd = bashCommand(input.tool_input);
            const reason = bashViolation(ctx.config, cmd);
            if (!reason) return {};
            ctx.report(`Shell safety blocked ${ctx.agent.name}: ${reason} — \`${cmd.slice(0, 120)}\``);
            return deny(`Blocked by shell safety guardrail (${reason}). Do not retry this command; explain what you needed instead.`);
          },
        ],
      },
    ],
  }),
};

export function bashViolation(config: BashSafetyConfig, cmd: string): string | undefined {
  for (const [pattern, label] of DANGEROUS) {
    if (label === 'force push' && config.allowForcePush) continue;
    if (new RegExp(pattern).test(cmd)) return label;
  }
  if (!config.allowInstalls && new RegExp(INSTALL).test(cmd)) return 'package install (allowInstalls is off)';
  const extra = matchesAny(config.extraDeny, cmd);
  if (extra) return `matches denied pattern ${extra}`;
  if (config.allowlistOnly && !matchesAny(config.allowlist, cmd)) return 'not on the command allowlist';
  return undefined;
}

// ------------------------------------------------------------ protected-paths

interface ProtectedPathsConfig {
  globs: string[];
}

const WRITING_SHELL = /(>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\btruncate\b|\bchmod\b|\bgit\s+checkout\b)/;

export const protectedPaths: GuardrailDef<ProtectedPathsConfig> = {
  id: 'protected-paths',
  title: 'Protected paths',
  summary: 'Agents cannot edit files matching these globs (lockfiles, env files, CI, migrations) unless marked as allowed in their settings.',
  layer: 'gate',
  fields: [{ key: 'globs', label: 'Protected globs', type: 'list' }],
  appliesTo: () => true,
  defaults: () => ({
    globs: ['.env', '.env.*', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', '.github/**', '**/migrations/**', '.roundtable/guardrails.json'],
  }),
  status: () => 'ready',
  hooks: (ctx) => {
    if (ctx.agent.canEditProtected) return {};
    const isProtected = globMatcher(ctx.config.globs);
    const refuse = (file: string) => {
      ctx.report(`Protected path: ${ctx.agent.name} tried to change ${file}`);
      return deny(`${file} is a protected path in this project. Do not modify it; ask the user if the change is needed.`);
    };
    return {
      PreToolUse: [
        {
          matcher: MUTATING_TOOLS,
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name !== 'PreToolUse') return {};
              const file = toolFilePath(input.tool_input);
              if (!file) return {};
              const rel = projectRelative(ctx, file);
              return isProtected(rel) ? refuse(rel) : {};
            },
          ],
        },
        {
          matcher: 'Bash',
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name !== 'PreToolUse') return {};
              const cmd = bashCommand(input.tool_input);
              if (!WRITING_SHELL.test(cmd)) return {};
              const hit = shellTargets(cmd).map((t) => projectRelative(ctx, t)).find(isProtected);
              return hit ? refuse(hit) : {};
            },
          ],
        },
      ],
    };
  },
  prompt: (ctx) => (ctx.agent.canEditProtected ? '' : `Files matching these globs are off limits: ${ctx.config.globs.join(', ')}.`),
};

/** Path-looking tokens in a shell command. */
function shellTargets(cmd: string): string[] {
  return (cmd.match(/[^\s"'<>|;&=]+/g) ?? []).filter((t) => /[./]/.test(t) && !t.startsWith('-') && !/^https?:/.test(t));
}

// --------------------------------------------------------------- secrets-scan

interface SecretsConfig {
  gitleaks: boolean;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private key'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{60,}/, 'GitHub fine-grained token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/sk_live_[0-9a-zA-Z]{20,}/, 'Stripe live key'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/sk-[A-Za-z0-9]{40,}/, 'OpenAI-style API key'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9+/_\-]{24,}["']/i, 'hard-coded credential'],
];

export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

export const secretsScan: GuardrailDef<SecretsConfig> = {
  id: 'secrets-scan',
  title: 'Secrets scan',
  summary: 'Flags API keys, tokens and private keys the moment they are written, and blocks the turn until they are removed. Runs gitleaks on commits when installed.',
  layer: 'gate',
  fields: [{ key: 'gitleaks', label: 'Run gitleaks on git commit (when installed)', type: 'boolean' }],
  appliesTo: () => true,
  defaults: () => ({ gitleaks: true }),
  status: () => 'ready',
  hooks: (ctx) => ({
    PostToolUse: [
      {
        matcher: MUTATING_TOOLS,
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== 'PostToolUse') return {};
            const hits = findSecrets(toolWrittenText(input.tool_input));
            if (hits.length === 0) return {};
            const file = toolFilePath(input.tool_input) ?? 'the file';
            ctx.report(`Secrets scan: ${ctx.agent.name} wrote what looks like a ${hits[0]} into ${projectRelative(ctx, file)}`);
            return feedback(`Secrets scan: ${file} now contains what looks like a ${hits.join(', ')}. Remove it and read the value from an environment variable or secret store instead. You cannot finish this turn while it is there.`);
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            if (!ctx.config.gitleaks || !ctx.profile.tools.gitleaks) return {};
            if (!/\bgit\s+commit\b/.test(bashCommand(input.tool_input))) return {};
            const bin = ctx.runner.resolveBin(ctx.root, 'gitleaks');
            if (!bin) return {};
            const result = await ctx.runner.run(bin, ['protect', '--staged', '--no-banner', '--redact'], { cwd: ctx.cwd, timeoutMs: 60_000 });
            if (result.code === 0) return {};
            ctx.report(`Secrets scan: gitleaks blocked a commit by ${ctx.agent.name}`);
            return deny(`gitleaks found secrets in the staged changes:\n${tail(result.output, 20)}\nRemove them before committing.`);
          },
        ],
      },
    ],
  }),
  stopCheck: async (ctx) => {
    for (const rel of ctx.turn.editedFiles) {
      const text = readFileCapped(path.join(ctx.cwd, rel));
      if (!text) continue;
      const hits = findSecrets(text);
      if (hits.length > 0) return `${rel} still contains what looks like a ${hits.join(', ')}. Remove it before finishing.`;
    }
    return undefined;
  },
  prompt: () => 'Never write credentials, tokens or private keys into files. Use environment variables.',
};

// ------------------------------------------------------------- typecheck-gate

interface TypecheckConfig {
  command: string;
  onEdit: boolean;
  minIntervalSec: number;
}

export const typecheckGate: GuardrailDef<TypecheckConfig> = {
  id: 'typecheck-gate',
  title: 'Typecheck gate',
  summary: 'Runs tsc after TypeScript edits and before an agent may finish; errors go back to the agent.',
  layer: 'gate',
  fields: [
    { key: 'command', label: 'Command', type: 'text' },
    { key: 'onEdit', label: 'Also run after each edit', type: 'boolean' },
    { key: 'minIntervalSec', label: 'Minimum seconds between edit-time runs', type: 'number' },
  ],
  appliesTo: (p) => p.typescript,
  defaults: (p) => ({ command: p.tsconfig ? `tsc --noEmit -p ${p.tsconfig}` : 'tsc --noEmit', onEdit: true, minIntervalSec: 20 }),
  status: (p) => (p.tools.tsc ? 'ready' : 'missing-tool'),
  setup: async (p) => (p.tools.tsc ? [] : [{ kind: 'install', packages: ['typescript'], description: 'Install typescript (tsc)' }]),
  hooks: (ctx) => ({
    PostToolUse: [
      {
        matcher: MUTATING_TOOLS,
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== 'PostToolUse' || !ctx.config.onEdit) return {};
            const file = toolFilePath(input.tool_input);
            if (!file || !TS_FILE.test(file) || !throttle(ctx, 'typecheck', ctx.config.minIntervalSec)) return {};
            const result = await runCommand(ctx, ctx.config.command);
            if (result.code === 0) return {};
            return feedback(`Typecheck failed after your edit (${ctx.config.command}):\n${tail(result.output, 30)}`);
          },
        ],
      },
    ],
  }),
  stopCheck: async (ctx) => {
    if (editedMatching(ctx, TS_FILE).length === 0) return undefined;
    const result = await runCommand(ctx, ctx.config.command);
    if (result.code === 0) return undefined;
    return `Typecheck fails (${ctx.config.command}). Fix these before finishing:\n${tail(result.output, 40)}`;
  },
  prompt: (ctx) => `TypeScript must typecheck (${ctx.config.command}) before you finish a turn in which you edited .ts files.`,
};

// ------------------------------------------------------------------ lint-gate

interface LintConfig {
  maxWarnings: number;
  onEdit: boolean;
}

export const lintGate: GuardrailDef<LintConfig> = {
  id: 'lint-gate',
  title: 'Lint gate',
  summary: 'Runs eslint on the files an agent changed, after each edit and before it may finish.',
  layer: 'gate',
  fields: [
    { key: 'maxWarnings', label: 'Max warnings', type: 'number' },
    { key: 'onEdit', label: 'Also run after each edit', type: 'boolean' },
  ],
  appliesTo: (p) => p.node && p.eslint,
  defaults: () => ({ maxWarnings: 0, onEdit: true }),
  status: (p) => (p.tools.eslint ? 'ready' : 'missing-tool'),
  setup: async (p) => (p.tools.eslint ? [] : [{ kind: 'install', packages: ['eslint'], description: 'Install eslint' }]),
  hooks: (ctx) => ({
    PostToolUse: [
      {
        matcher: MUTATING_TOOLS,
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== 'PostToolUse' || !ctx.config.onEdit) return {};
            const file = toolFilePath(input.tool_input);
            if (!file || !JS_TS_FILE.test(file)) return {};
            const result = await lint(ctx, [projectRelative(ctx, file)]);
            return result.code === 0 ? {} : feedback(`eslint reported problems after your edit:\n${tail(result.output, 30)}`);
          },
        ],
      },
    ],
  }),
  stopCheck: async (ctx) => {
    const files = editedMatching(ctx, JS_TS_FILE);
    if (files.length === 0) return undefined;
    const result = await lint(ctx, files);
    return result.code === 0 ? undefined : `eslint fails on files you changed. Fix these before finishing:\n${tail(result.output, 40)}`;
  },
  prompt: (ctx) => `eslint must pass (max ${ctx.config.maxWarnings} warnings) on files you change.`,
};

function lint(ctx: HookCtx<LintConfig>, files: string[]) {
  return runCommand(ctx, 'eslint', ['--max-warnings', String(ctx.config.maxWarnings), '--no-warn-ignored', ...files]);
}

// ----------------------------------------------------------------- tests-gate

interface TestsConfig {
  when: 'always' | 'whenEdited' | 'off';
  command: string;
  timeoutSec: number;
}

export const testsGate: GuardrailDef<TestsConfig> = {
  id: 'tests-gate',
  title: 'Tests gate',
  summary: 'Runs the test suite before an agent that changed code may finish its turn.',
  layer: 'gate',
  fields: [
    { key: 'when', label: 'Run', type: 'select', options: ['whenEdited', 'always', 'off'] },
    { key: 'command', label: 'Command', type: 'text' },
    { key: 'timeoutSec', label: 'Timeout (seconds)', type: 'number' },
  ],
  appliesTo: (p) => p.node,
  defaults: (p) => ({ when: 'whenEdited', command: p.testCommand ?? 'npm test', timeoutSec: 300 }),
  status: (p, c) => (c.command || p.testCommand ? 'ready' : 'needs-setup'),
  stopCheck: async (ctx) => {
    const { when, command, timeoutSec } = ctx.config;
    if (when === 'off' || !command) return undefined;
    if (when === 'whenEdited' && editedMatching(ctx, JS_TS_FILE).length === 0) return undefined;
    const result = await runCommand(ctx, command, [], timeoutSec * 1000);
    if (result.code === 0) return undefined;
    return result.timedOut
      ? `Tests timed out after ${timeoutSec}s (${command}). Investigate before finishing.`
      : `Tests fail (${command}). Fix them before finishing:\n${tail(result.output, 40)}`;
  },
  prompt: (ctx) => (ctx.config.when === 'off' ? '' : `Tests (${ctx.config.command}) must pass before you finish a turn in which you changed code.`),
};
