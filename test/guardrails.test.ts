import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HookCallback, HookInput, HookJSONOutput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { CATALOG, findGuardrail } from '../src/guardrails/catalog';
import { bashViolation, findSecrets } from '../src/guardrails/catalog/gates';
import { depcruiseConfig, generateArchitectureMap } from '../src/guardrails/catalog/knowledge';
import { detectProject } from '../src/guardrails/detect';
import { PRESETS } from '../src/guardrails/presets';
import type { RunResult, Runner } from '../src/guardrails/runner';
import { GuardrailRuntime } from '../src/guardrails/runtime';
import { planSetup } from '../src/guardrails/setup';
import { resolveGuardrails, selectPreset, setGuardrailConfig, toggleGuardrail } from '../src/guardrails/store';
import type { GuardrailsFile, HookMap, ProjectProfile } from '../src/guardrails/types';
import type { AgentConfig } from '../src/shared/protocol';

// ---- fixture project ----

let root: string;
let profile: ProjectProfile;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-gr-'));
  fs.mkdirSync(path.join(root, 'src/room'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/ui'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' }, devDependencies: { typescript: '5', vitest: '3', eslint: '9' } }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  fs.writeFileSync(path.join(root, 'src/room/index.ts'), 'export const x = 1;\n');
  profile = detectProject(root);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function agent(name: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: name.toLowerCase(),
    name,
    color: '#000',
    role: '',
    model: 'm',
    effort: 'low',
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    workspaceMode: 'shared',
    ...extra,
  };
}

/** Runner that returns scripted results and records calls. */
class FakeRunner implements Runner {
  calls: string[] = [];
  constructor(private script: (file: string, args: string[]) => Partial<RunResult> = () => ({})) {}
  async run(file: string, args: string[]): Promise<RunResult> {
    this.calls.push([path.basename(file), ...args].join(' '));
    return { code: 0, output: '', timedOut: false, ...this.script(file, args) };
  }
  resolveBin(_root: string, name: string): string | undefined {
    return `/bin/${name}`;
  }
}

function runtimeWith(file: GuardrailsFile, runner: Runner = new FakeRunner(), reports: string[] = []) {
  const rt = new GuardrailRuntime({ profile, root, runner, report: (t) => reports.push(t), stateChanged: () => undefined });
  rt.setEffective(resolveGuardrails(file, PRESETS, CATALOG, profile));
  return { rt, reports };
}

function pre(toolName: string, input: unknown): HookInput {
  return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: root } as HookInput;
}
function postUse(toolName: string, input: unknown): HookInput {
  return { hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: input, tool_response: {}, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: root } as HookInput;
}
function stop(last = ''): HookInput {
  return { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: last, session_id: 's', transcript_path: '', cwd: root } as HookInput;
}

/** Run every hook registered for an event whose matcher matches the tool; return the first non-empty output. */
async function fire(hooks: HookMap, input: HookInput): Promise<SyncHookJSONOutput> {
  const toolName = 'tool_name' in input ? input.tool_name : '';
  for (const matcher of hooks[input.hook_event_name] ?? []) {
    if (matcher.matcher && !new RegExp(`^(${matcher.matcher})$`).test(toolName)) continue;
    for (const hook of matcher.hooks as HookCallback[]) {
      const out = (await hook(input, 't1', { signal: new AbortController().signal })) as HookJSONOutput;
      if (Object.keys(out).length > 0) return out as SyncHookJSONOutput;
    }
  }
  return {};
}

const decision = (out: SyncHookJSONOutput) => (out.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;
const context = (out: SyncHookJSONOutput) => (out.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

// ---- tests ----

describe('detect', () => {
  it('reads stack, package manager, test runner and source dirs', () => {
    expect(profile.typescript).toBe(true);
    expect(profile.packageManager).toBe('pnpm');
    expect(profile.testRunner).toBe('vitest');
    expect(profile.testCommand).toBe('pnpm test');
    expect(profile.srcDirs).toEqual(['src/room', 'src/ui']);
    expect(profile.git).toBe(true);
    expect(profile.eslint).toBe(true);
  });
});

describe('store', () => {
  it('resolves preset minus disabled plus enabled, with config layering', () => {
    const file: GuardrailsFile = { preset: 'team', enabled: { boundaries: true, 'tests-gate': { when: 'always' } }, disabled: ['lint-gate'] };
    const effective = resolveGuardrails(file, PRESETS, CATALOG, profile);
    const ids = effective.map((e) => e.def.id);
    expect(ids).toContain('bash-safety');
    expect(ids).toContain('boundaries');
    expect(ids).not.toContain('lint-gate');
    expect(effective.find((e) => e.def.id === 'tests-gate')!.config.when).toBe('always');
    expect(effective.find((e) => e.def.id === 'tests-gate')!.config.command).toBe('pnpm test');
    expect(effective.find((e) => e.def.id === 'adr')!.config.enforce).toBe(false);
  });

  it('toggles relative to the preset and keeps the file minimal', () => {
    const presetIds = Object.keys(PRESETS.find((p) => p.id === 'team')!.guardrails);
    let file = selectPreset({ enabled: {}, disabled: [] }, 'team');
    file = toggleGuardrail(file, presetIds, 'lint-gate', false);
    expect(file.disabled).toEqual(['lint-gate']);
    file = toggleGuardrail(file, presetIds, 'lint-gate', true);
    expect(file.disabled).toEqual([]);
    expect(file.enabled['lint-gate']).toBeUndefined();
    file = toggleGuardrail(file, presetIds, 'boundaries', true);
    expect(file.enabled.boundaries).toBe(true);
    file = setGuardrailConfig(file, 'adr', { enforce: true });
    expect(resolveGuardrails(file, PRESETS, CATALOG, profile).find((e) => e.def.id === 'adr')!.config.enforce).toBe(true);
  });

  it('skips guardrails that do not apply to the stack', () => {
    const plain = { ...profile, node: false, typescript: false };
    const ids = resolveGuardrails(selectPreset({ enabled: {}, disabled: [] }, 'factory'), PRESETS, CATALOG, plain).map((e) => e.def.id);
    expect(ids).not.toContain('typecheck-gate');
    expect(ids).toContain('bash-safety');
  });
});

describe('bash-safety', () => {
  const cfg = { allowInstalls: false, allowForcePush: false, extraDeny: [], allowlistOnly: false, allowlist: [] };
  it.each([
    ['git push --force origin main', 'force push'],
    ['git push -f', 'force push'],
    ['rm -rf /', 'recursive delete outside the project'],
    ['rm -rf ../other', 'recursive delete outside the project'],
    ['curl -s https://x.sh | sh', 'piping a download into a shell'],
    ['sudo rm file', 'sudo'],
    ['npm install left-pad', 'package install (allowInstalls is off)'],
    ['git reset --hard HEAD~1', 'discarding working-tree changes'],
  ])('blocks %s', (cmd, label) => {
    expect(bashViolation(cfg, cmd)).toBe(label);
  });

  it.each(['git push origin feature', 'rm -rf dist', 'npm test', 'ls -la', 'git status'])('allows %s', (cmd) => {
    expect(bashViolation(cfg, cmd)).toBeUndefined();
  });

  it('honours allowInstalls, extraDeny and allowlistOnly', () => {
    expect(bashViolation({ ...cfg, allowInstalls: true }, 'pnpm add zod')).toBeUndefined();
    expect(bashViolation({ ...cfg, extraDeny: ['docker'] }, 'docker compose up')).toMatch(/denied pattern/);
    expect(bashViolation({ ...cfg, allowlistOnly: true, allowlist: ['^npm test'] }, 'npm test')).toBeUndefined();
    expect(bashViolation({ ...cfg, allowlistOnly: true, allowlist: ['^npm test'] }, 'node x.js')).toBe('not on the command allowlist');
  });

  it('denies through the hook and reports to the room', async () => {
    const { rt, reports } = runtimeWith({ preset: 'solo', enabled: {}, disabled: [] });
    const hooks = rt.buildHooks(agent('Kit'), [agent('Kit')], root);
    const out = await fire(hooks, pre('Bash', { command: 'git push --force' }));
    expect(decision(out)).toBe('deny');
    expect(reports[0]).toMatch(/Shell safety blocked Kit: force push/);
  });
});

describe('protected-paths', () => {
  it('denies edits to protected files but not others, and respects canEditProtected', async () => {
    const { rt } = runtimeWith({ preset: 'solo', enabled: {}, disabled: [] });
    const kit = agent('Kit');
    const hooks = rt.buildHooks(kit, [kit], root);
    expect(decision(await fire(hooks, pre('Edit', { file_path: path.join(root, 'package-lock.json') })))).toBe('deny');
    expect(decision(await fire(hooks, pre('Write', { file_path: path.join(root, '.env.local') })))).toBe('deny');
    expect(decision(await fire(hooks, pre('Edit', { file_path: path.join(root, 'src/db/migrations/001.sql') })))).toBe('deny');
    expect(decision(await fire(hooks, pre('Edit', { file_path: path.join(root, 'src/room/index.ts') })))).toBeUndefined();
    expect(decision(await fire(hooks, pre('Bash', { command: 'echo x >> .env' })))).toBe('deny');
    expect(decision(await fire(hooks, pre('Bash', { command: 'cat .env' })))).toBeUndefined();

    const admin = agent('Ada', { canEditProtected: true });
    const adminHooks = rt.buildHooks(admin, [admin], root);
    expect(decision(await fire(adminHooks, pre('Edit', { file_path: path.join(root, 'package-lock.json') })))).toBeUndefined();
  });
});

describe('secrets-scan', () => {
  it('recognises common secret shapes', () => {
    expect(findSecrets('const k = "AKIAIOSFODNN7EXAMPLE";')).toEqual(['AWS access key']);
    expect(findSecrets('-----BEGIN RSA PRIVATE KEY-----')).toEqual(['private key']);
    expect(findSecrets('api_key = "abcdefghijklmnopqrstuvwxyz0123456789"')).toEqual(['hard-coded credential']);
    expect(findSecrets('const port = 3000;')).toEqual([]);
  });

  it('feeds back after a write and blocks Stop until the file is clean', async () => {
    const { rt } = runtimeWith({ preset: 'solo', enabled: {}, disabled: [] });
    const kit = agent('Kit');
    const hooks = rt.buildHooks(kit, [kit], root);
    const file = path.join(root, 'src/room/secret.ts');
    fs.writeFileSync(file, 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
    rt.onTurnStart(kit.id);
    const out = await fire(hooks, postUse('Write', { file_path: file, content: fs.readFileSync(file, 'utf8') }));
    expect(context(out)).toMatch(/AWS access key/);
    const blocked = await fire(hooks, stop());
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toMatch(/Secrets scan/);
    fs.writeFileSync(file, 'export const key = process.env.KEY;\n');
    expect(await fire(hooks, stop())).toEqual({});
  });
});

describe('typecheck / lint / tests gates', () => {
  it('run only when relevant files were edited and block on failure', async () => {
    const runner = new FakeRunner((file) => (path.basename(file) === 'tsc' ? { code: 2, output: 'src/room/index.ts(1,1): error TS2322' } : {}));
    const { rt } = runtimeWith({ preset: 'team', enabled: {}, disabled: ['secrets-scan'] }, runner);
    const kit = agent('Kit');
    const hooks = rt.buildHooks(kit, [kit], root);
    rt.onTurnStart(kit.id);

    // No edits yet: Stop passes without running anything.
    expect(await fire(hooks, stop())).toEqual({});
    expect(runner.calls).toEqual([]);

    await fire(hooks, postUse('Edit', { file_path: path.join(root, 'README.md'), new_string: 'x' }));
    expect(await fire(hooks, stop())).toEqual({});
    expect(runner.calls.some((c) => c.startsWith('tsc'))).toBe(false);

    const edit = await fire(hooks, postUse('Edit', { file_path: path.join(root, 'src/room/index.ts'), new_string: 'x' }));
    expect(context(edit)).toMatch(/Typecheck failed/);
    expect(runner.calls.some((c) => c.startsWith('tsc --noEmit -p tsconfig.json'))).toBe(true);

    const blocked = await fire(hooks, stop());
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toMatch(/\[Typecheck gate\]/);
  });

  it('lets the agent finish after two blocks and reports the unmet gate', async () => {
    const runner = new FakeRunner((file) => (path.basename(file) === 'tsc' ? { code: 2, output: 'error' } : {}));
    const { rt, reports } = runtimeWith({ enabled: { 'typecheck-gate': { onEdit: false } }, disabled: [] }, runner);
    const kit = agent('Kit');
    const hooks = rt.buildHooks(kit, [kit], root);
    rt.onTurnStart(kit.id);
    await fire(hooks, postUse('Edit', { file_path: path.join(root, 'src/room/index.ts'), new_string: 'x' }));
    expect((await fire(hooks, stop())).decision).toBe('block');
    expect((await fire(hooks, stop())).decision).toBe('block');
    expect(await fire(hooks, stop())).toEqual({});
    expect(reports.at(-1)).toMatch(/Kit finished with an unmet gate \(Typecheck gate\)/);
  });

  it('runs tests and lint on Stop when code changed', async () => {
    const runner = new FakeRunner((file) => (path.basename(file) === 'pnpm' ? { code: 1, output: '1 failed' } : {}));
    const { rt } = runtimeWith({ enabled: { 'tests-gate': true, 'lint-gate': { onEdit: false } }, disabled: [] }, runner);
    const kit = agent('Kit');
    const hooks = rt.buildHooks(kit, [kit], root);
    rt.onTurnStart(kit.id);
    await fire(hooks, postUse('Write', { file_path: path.join(root, 'src/ui/a.ts'), content: 'x' }));
    const blocked = await fire(hooks, stop());
    expect(blocked.reason).toMatch(/Tests fail \(pnpm test\)/);
    expect(runner.calls).toContain('eslint --max-warnings 0 --no-warn-ignored src/ui/a.ts');
  });
});

describe('knowledge', () => {
  it('generates an architecture map and a dependency-cruiser config from it', () => {
    const map = generateArchitectureMap(profile);
    expect(map.modules.map((m) => m.name)).toEqual(['room', 'ui']);
    map.modules[1]!.allow = []; // ui may import nothing
    const config = depcruiseConfig(map);
    expect(config).toContain('"name":"ui-not-to-room"');
    expect(config).not.toContain('room-not-to-ui');
    expect(config).toContain("name: 'no-circular'");
  });

  it('plans setup once per file across guardrails and installs missing tools', async () => {
    const effective = resolveGuardrails({ preset: 'factory', enabled: {}, disabled: [] }, PRESETS, CATALOG, profile);
    const plan = await planSetup(effective, profile, [agent('Ada'), agent('Rex', { role: 'Skeptic reviewer' }), agent('Kit')]);
    const writes = plan.actions.filter((a) => a.kind === 'write').map((a) => (a as { path: string }).path);
    expect(new Set(writes).size).toBe(writes.length);
    expect(writes).toContain('docs/architecture.yml');
    expect(writes).toContain('.dependency-cruiser.cjs');
    expect(writes).toContain('AGENTS.md');
    expect(writes).toContain('docs/adr/0001-record-architecture-decisions.md');
    const installs = plan.actions.filter((a) => a.kind === 'install').flatMap((a) => (a as { packages: string[] }).packages);
    expect(installs).toContain('dependency-cruiser');
    const agentActions = plan.actions.filter((a) => a.kind === 'agents').map((a) => a.description);
    expect(agentActions).toEqual(['Mark Rex as the reviewer (read-only)', 'Switch Ada, Rex, Kit to worktree mode']);
  });

  it('adr enforce blocks architecture edits without an ADR; DoD requires a DoD line', async () => {
    const { rt } = runtimeWith({ enabled: { adr: { enforce: true }, 'definition-of-done': { require: true } }, disabled: [] });
    const kit = agent('Kit');
    const hooks = rt.buildHooks(kit, [kit], root);
    rt.onTurnStart(kit.id);
    await fire(hooks, postUse('Edit', { file_path: path.join(root, 'package.json'), new_string: 'x' }));
    expect((await fire(hooks, stop('done'))).reason).toMatch(/without recording the decision/);
    await fire(hooks, postUse('Write', { file_path: path.join(root, 'docs/adr/0002-x.md'), content: 'x' }));
    expect((await fire(hooks, stop('done'))).reason).toMatch(/"DoD:"/);
    expect(await fire(hooks, stop('All good.\nDoD: tests added, typecheck passes'))).toEqual({});
  });
});

describe('process', () => {
  it('reviewer veto locks edits until approve_plan, and resets per user message', async () => {
    const { rt, reports } = runtimeWith({ enabled: { 'reviewer-veto': true }, disabled: [] });
    const rex = agent('Rex', { reviewer: true });
    const kit = agent('Kit');
    const roster = [rex, kit];
    rt.onUserMessage();
    const kitHooks = rt.buildHooks(kit, roster, root);
    expect(decision(await fire(kitHooks, pre('Edit', { file_path: 'src/a.ts' })))).toBe('deny');
    expect(decision(await fire(kitHooks, pre('Bash', { command: 'git status' })))).toBeUndefined();
    expect(decision(await fire(kitHooks, pre('Bash', { command: 'node build.js' })))).toBe('deny');
    expect(rt.locks.review).toBeDefined();

    expect(rt.buildTools(kit, roster, root)).toEqual([]);
    expect(rt.buildDisallowed(rex, roster, root)).toContain('Edit');
    const approve = rt.buildTools(rex, roster, root).find((t) => t.name === 'approve_plan')!;
    await approve.handler({ summary: 'ship it' });
    expect(reports.at(-1)).toBe('Rex approved the plan: ship it');
    expect(decision(await fire(kitHooks, pre('Edit', { file_path: 'src/a.ts' })))).toBeUndefined();
    expect(rt.locks.review).toBeUndefined();

    rt.onUserMessage();
    expect(decision(await fire(kitHooks, pre('Edit', { file_path: 'src/a.ts' })))).toBe('deny');
  });

  it('spec-first locks edits until the user approves a submitted spec', async () => {
    const { rt } = runtimeWith({ enabled: { 'spec-first': true }, disabled: [] });
    const kit = agent('Kit');
    rt.onUserMessage();
    const hooks = rt.buildHooks(kit, [kit], root);
    expect(decision(await fire(hooks, pre('Write', { file_path: 'src/a.ts' })))).toBe('deny');
    expect(rt.locks.spec).toBe('awaiting spec');

    const submit = rt.buildTools(kit, [kit], root).find((t) => t.name === 'submit_spec')!;
    await submit.handler({ markdown: '# Spec' });
    expect(rt.room.spec.status).toBe('pending');
    expect(rt.locks.spec).toBe('spec awaiting your decision');

    const { userMessage } = rt.specDecision('approve', 'looks good');
    expect(userMessage).toMatch(/Spec approved: looks good/);
    rt.onUserMessage(); // the approval is posted as a user message
    expect(rt.locks.spec).toBeUndefined();
    expect(decision(await fire(hooks, pre('Write', { file_path: 'src/a.ts' })))).toBeUndefined();

    rt.onUserMessage(); // next request needs a new spec
    expect(rt.locks.spec).toBe('awaiting spec');
  });

  it('prompts mention the guardrails', async () => {
    const { rt } = runtimeWith({ preset: 'factory', enabled: {}, disabled: [] });
    const rex = agent('Rex', { reviewer: true });
    const prompt = await rt.buildPrompt(rex, [rex, agent('Kit')], root);
    expect(prompt).toContain('## Project guardrails');
    expect(prompt).toContain('You are the reviewer');
    expect(prompt).toContain('Definition of done');
    expect(findGuardrail('spec-first')).toBeDefined();
  });
});
