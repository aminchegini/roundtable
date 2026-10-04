import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { tail } from '../runner';
import { MUTATING_TOOLS, feedback, toolFilePath, type GuardrailDef, type HookCtx, type ProjectProfile, type SetupAction } from '../types';
import { JS_TS_FILE, editedMatching, globMatcher, listLines, projectRelative, readFileCapped, runCommand } from './shared';

// ------------------------------------------------------------------ agents-md

export const agentsMd: GuardrailDef<Record<string, never>> = {
  id: 'agents-md',
  title: 'AGENTS.md',
  summary: 'Project instructions every agent reads: commands, layout, conventions. Created from detection if missing.',
  layer: 'knowledge',
  fields: [],
  appliesTo: () => true,
  defaults: () => ({}),
  status: (p) => (p.files.agentsMd || p.files.claudeMd ? 'ready' : 'needs-setup'),
  setup: async (p) =>
    p.files.agentsMd || p.files.claudeMd ? [] : [{ kind: 'write', path: 'AGENTS.md', content: agentsMdTemplate(p), description: 'Create AGENTS.md from detected commands and layout' }],
  prompt: (ctx) => {
    const text = readFileCapped(path.join(ctx.root, 'AGENTS.md'), 64 * 1024);
    return text ? `Project instructions (AGENTS.md):\n${text.trim()}` : '';
  },
};

function agentsMdTemplate(p: ProjectProfile): string {
  const pm = p.packageManager ?? 'npm';
  const scripts = Object.entries(p.scripts)
    .filter(([name]) => /^(build|test|lint|typecheck|dev|start|check|format)$/.test(name))
    .map(([name, cmd]) => `- \`${pm} run ${name}\` — ${cmd}`);
  return `# AGENTS.md

Instructions for AI agents working in this repository.

## Commands
${scripts.length > 0 ? scripts.join('\n') : `- \`${pm} test\``}

## Layout
${p.srcDirs.length > 0 ? p.srcDirs.map((d) => `- \`${d}/\` — describe what lives here`).join('\n') : '- describe the main folders here'}

## Conventions
- Match the style of surrounding code; do not reformat files you did not change.
- Keep changes small and focused on the request.
- Add or update tests next to the code you change.

## Do not
- Commit secrets or environment files.
- Change lockfiles or CI config without being asked.
`;
}

// ----------------------------------------------------------- architecture-map

export interface ArchitectureModule {
  name: string;
  path: string;
  allow: string[];
  description?: string;
}

export interface ArchitectureMap {
  modules: ArchitectureModule[];
}

export const ARCHITECTURE_FILE = 'docs/architecture.yml';

export function readArchitectureMap(root: string): ArchitectureMap | undefined {
  const text = readFileCapped(path.join(root, ARCHITECTURE_FILE));
  if (!text) return undefined;
  try {
    const data = parseYaml(text) as ArchitectureMap;
    if (!Array.isArray(data?.modules)) return undefined;
    return { modules: data.modules.filter((m) => m && typeof m.name === 'string' && typeof m.path === 'string').map((m) => ({ ...m, allow: Array.isArray(m.allow) ? m.allow : [] })) };
  } catch {
    return undefined;
  }
}

/** Starting map: one module per source dir, everything allowed, to be pruned by hand. */
export function generateArchitectureMap(p: ProjectProfile): ArchitectureMap {
  const dirs = p.srcDirs.length > 0 ? p.srcDirs : ['src'];
  const names = dirs.map((d) => path.basename(d));
  return {
    modules: dirs.map((dir, i) => ({
      name: names[i]!,
      path: dir,
      allow: names.filter((n) => n !== names[i]),
      description: '',
    })),
  };
}

export function architectureYaml(map: ArchitectureMap): string {
  return `# Architecture map — single source of truth for module boundaries.
# Each module lists the other modules it may import from. Remove entries from
# \`allow\` to tighten the architecture; the boundaries guardrail enforces it.
${stringifyYaml(map)}`;
}

export const architectureMapDef: GuardrailDef<Record<string, never>> = {
  id: 'architecture-map',
  title: 'Architecture map',
  summary: 'docs/architecture.yml lists modules and which modules each may import. Agents read it; the boundaries gate enforces it.',
  layer: 'knowledge',
  fields: [],
  appliesTo: () => true,
  defaults: () => ({}),
  status: (p) => (p.files.architectureYml ? 'ready' : 'needs-setup'),
  setup: async (p) =>
    p.files.architectureYml
      ? []
      : [{ kind: 'write', path: ARCHITECTURE_FILE, content: architectureYaml(generateArchitectureMap(p)), description: 'Create docs/architecture.yml from source folders (all imports allowed; prune by hand)' }],
  prompt: (ctx) => {
    const map = readArchitectureMap(ctx.root);
    if (!map) return '';
    const lines = map.modules.map((m) => `- ${m.name} (${m.path}) may import: ${m.allow.length > 0 ? m.allow.join(', ') : 'nothing'}${m.description ? ` — ${m.description}` : ''}`);
    return `Module boundaries (${ARCHITECTURE_FILE}):\n${lines.join('\n')}\nA new cross-module dependency needs a change to this file and an ADR, not a workaround.`;
  },
};

// ----------------------------------------------------------------- boundaries

interface BoundariesConfig {
  configFile: string;
}

export function depcruiseConfig(map: ArchitectureMap): string {
  const byName = new Map(map.modules.map((m) => [m.name, m]));
  const rules = map.modules.flatMap((from) =>
    map.modules
      .filter((to) => to.name !== from.name && !from.allow.includes(to.name))
      .map((to) => ({
        name: `${from.name}-not-to-${to.name}`,
        comment: `${from.name} may not import from ${to.name} (see docs/architecture.yml)`,
        severity: 'error',
        from: { path: `^${escapeRegex(from.path)}/` },
        to: { path: `^${escapeRegex(byName.get(to.name)!.path)}/` },
      })),
  );
  return `// Generated by Roundtable from docs/architecture.yml — regenerate instead of editing by hand.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', comment: 'Circular dependencies make modules impossible to reason about in isolation.', from: {}, to: { circular: true } },
${rules.map((r) => `    ${JSON.stringify(r)},`).join('\n')}
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const boundaries: GuardrailDef<BoundariesConfig> = {
  id: 'boundaries',
  title: 'Module boundaries',
  summary: 'dependency-cruiser enforces docs/architecture.yml: forbidden imports and cycles fail the turn.',
  layer: 'gate',
  fields: [{ key: 'configFile', label: 'dependency-cruiser config', type: 'text' }],
  appliesTo: (p) => p.node,
  defaults: () => ({ configFile: '.dependency-cruiser.cjs' }),
  status: (p, c) => (!p.tools.depcruise ? 'missing-tool' : fs.existsSync(path.join(p.root ?? '', c.configFile)) && p.files.architectureYml ? 'ready' : 'needs-setup'),
  setup: async (p, c) => {
    const actions: SetupAction[] = [];
    if (!p.tools.depcruise) actions.push({ kind: 'install', packages: ['dependency-cruiser'], description: 'Install dependency-cruiser' });
    const map = readArchitectureMap(p.root ?? '') ?? generateArchitectureMap(p);
    if (!p.files.architectureYml) {
      actions.push({ kind: 'write', path: ARCHITECTURE_FILE, content: architectureYaml(map), description: 'Create docs/architecture.yml from source folders' });
    }
    if (!fs.existsSync(path.join(p.root ?? '', c.configFile))) {
      actions.push({ kind: 'write', path: c.configFile, content: depcruiseConfig(map), description: `Generate ${c.configFile} from the architecture map` });
    }
    return actions;
  },
  hooks: (ctx) => ({
    PostToolUse: [
      {
        matcher: MUTATING_TOOLS,
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== 'PostToolUse') return {};
            const file = toolFilePath(input.tool_input);
            if (!file || !JS_TS_FILE.test(file)) return {};
            const result = await cruise(ctx, [projectRelative(ctx, file)]);
            return result.code === 0 ? {} : feedback(`Module boundary violation after your edit:\n${tail(result.output, 30)}`);
          },
        ],
      },
    ],
  }),
  stopCheck: async (ctx) => {
    const files = editedMatching(ctx, JS_TS_FILE);
    if (files.length === 0) return undefined;
    const result = await cruise(ctx, files);
    return result.code === 0 ? undefined : `Module boundaries are violated by files you changed:\n${tail(result.output, 40)}`;
  },
  prompt: () => 'Imports across module boundaries are checked by dependency-cruiser; a violation blocks your turn.',
};

function cruise(ctx: HookCtx<BoundariesConfig>, files: string[]) {
  return runCommand(ctx, 'depcruise', ['--config', ctx.config.configFile, '--output-type', 'err', ...files]);
}

// ------------------------------------------------------------------------ adr

interface AdrConfig {
  enforce: boolean;
  archGlobs: string[];
}

const ADR_DIR = 'docs/adr';

export const adr: GuardrailDef<AdrConfig> = {
  id: 'adr',
  title: 'Architecture decision records',
  summary: 'Agents record architecture decisions in docs/adr. With enforce on, a turn that touches architecture files without an ADR is blocked.',
  layer: 'knowledge',
  fields: [
    { key: 'enforce', label: 'Block turns that change architecture files without an ADR', type: 'boolean' },
    { key: 'archGlobs', label: 'Architecture file globs', type: 'list' },
  ],
  appliesTo: () => true,
  defaults: () => ({
    enforce: false,
    archGlobs: ['docs/architecture.yml', 'package.json', 'tsconfig*.json', '.dependency-cruiser.cjs', '**/schema.*', '**/migrations/**', 'src/*/index.ts'],
  }),
  status: (p) => (p.files.adrDir ? 'ready' : 'needs-setup'),
  setup: async (p) =>
    p.files.adrDir
      ? []
      : [
          { kind: 'write', path: `${ADR_DIR}/0001-record-architecture-decisions.md`, content: FIRST_ADR, description: 'Create docs/adr with the first ADR' },
          { kind: 'write', path: `${ADR_DIR}/template.md`, content: ADR_TEMPLATE, description: 'Add the ADR template' },
        ],
  stopCheck: async (ctx) => {
    if (!ctx.config.enforce) return undefined;
    const isArch = globMatcher(ctx.config.archGlobs);
    const touched = [...ctx.turn.editedFiles].filter(isArch);
    if (touched.length === 0) return undefined;
    const wroteAdr = [...ctx.turn.editedFiles].some((f) => f.startsWith(`${ADR_DIR}/`));
    if (wroteAdr) return undefined;
    return `You changed architecture files (${touched.join(', ')}) without recording the decision. Add a short ADR under ${ADR_DIR}/ (copy template.md, next number) before finishing.`;
  },
  prompt: (ctx) => {
    const existing = listAdrs(ctx.root);
    return [
      `Architecture decisions are recorded in ${ADR_DIR}/ (one file per decision, numbered, copy template.md).`,
      ctx.config.enforce ? `Changing files matching ${ctx.config.archGlobs.join(', ')} requires an ADR in the same turn.` : 'Write an ADR when you change structure, dependencies or contracts.',
      existing.length > 0 ? `Existing ADRs:\n${listLines(existing.slice(-15))}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },
};

function listAdrs(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, ADR_DIR))
      .filter((f) => /^\d{4}-.*\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

const ADR_TEMPLATE = `# NNNN. Title

Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by NNNN

## Context
What forces are at play; what problem this decides.

## Decision
What we are doing, in one or two paragraphs.

## Consequences
What becomes easier, what becomes harder, what we must watch.
`;

const FIRST_ADR = `# 0001. Record architecture decisions

Date: ${new Date().toISOString().slice(0, 10)}
Status: Accepted

## Context
Architecture decisions made by people and AI agents need to be findable later, with the reasoning intact.

## Decision
We keep Architecture Decision Records in \`docs/adr\`, one Markdown file per decision, numbered sequentially, using \`template.md\`.

## Consequences
Every structural change comes with a short record. Agents working in this repository are told to write one.
`;

// ----------------------------------------------------------- definition-of-done

interface DodConfig {
  items: string[];
  require: boolean;
}

export const definitionOfDone: GuardrailDef<DodConfig> = {
  id: 'definition-of-done',
  title: 'Definition of done',
  summary: 'A checklist every implementation turn must satisfy; with require on, the agent must report which items it verified.',
  layer: 'knowledge',
  fields: [
    { key: 'items', label: 'Checklist', type: 'list' },
    { key: 'require', label: 'Require a "DoD:" line in the final reply', type: 'boolean' },
  ],
  appliesTo: () => true,
  defaults: () => ({
    items: [
      'Behaviour change is covered by a test',
      'Typecheck, lint and tests pass locally',
      'No new TODOs without an issue reference',
      'Public interfaces and docs updated',
      'Change is small enough to review in one sitting',
    ],
    require: false,
  }),
  status: () => 'ready',
  stopCheck: async (ctx, lastMessage) => {
    if (!ctx.config.require || ctx.turn.editedFiles.size === 0) return undefined;
    if (/\bDoD\s*:/i.test(lastMessage)) return undefined;
    return 'End your reply with a line starting "DoD:" that says which definition-of-done items you verified and how, or which you could not.';
  },
  prompt: (ctx) =>
    `Definition of done for code changes:\n${listLines(ctx.config.items)}${ctx.config.require ? '\nWhen you changed files, end your reply with a "DoD:" line listing what you verified.' : ''}`,
};
