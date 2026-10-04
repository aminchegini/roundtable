import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentConfig } from '../shared/protocol';
import type { Runner } from './runner';
import type { EffectiveGuardrail } from './store';
import type { ProjectProfile, SetupAction } from './types';

export interface SetupPlan {
  actions: Array<SetupAction & { guardrailId: string }>;
}

/** Everything the enabled guardrails still need written or installed. */
export async function planSetup(effective: EffectiveGuardrail[], profile: ProjectProfile, agents: AgentConfig[]): Promise<SetupPlan> {
  const actions: SetupPlan['actions'] = [];
  const seenPaths = new Set<string>();
  const seenPackages = new Set<string>();
  for (const { def, config } of effective) {
    if (!def.setup) continue;
    for (const action of await def.setup(profile, config, agents)) {
      // Two guardrails may want the same file (architecture map + boundaries); write it once.
      if (action.kind === 'write') {
        if (seenPaths.has(action.path)) continue;
        seenPaths.add(action.path);
      }
      if (action.kind === 'install') {
        const fresh = action.packages.filter((p) => !seenPackages.has(p));
        if (fresh.length === 0) continue;
        fresh.forEach((p) => seenPackages.add(p));
        actions.push({ ...action, packages: fresh, guardrailId: def.id });
        continue;
      }
      actions.push({ ...action, guardrailId: def.id });
    }
  }
  return { actions };
}

export function describeSetup(plan: SetupPlan): Array<{ kind: SetupAction['kind']; description: string; detail: string }> {
  return plan.actions.map((a) => ({
    kind: a.kind,
    description: a.description,
    detail: a.kind === 'write' ? a.path : a.kind === 'install' ? a.packages.join(', ') : '',
  }));
}

export interface ApplyResult {
  written: string[];
  installed: string[];
  agents: AgentConfig[];
  errors: string[];
}

export async function applySetup(plan: SetupPlan, profile: ProjectProfile, agents: AgentConfig[], runner: Runner): Promise<ApplyResult> {
  const root = profile.root;
  const result: ApplyResult = { written: [], installed: [], agents, errors: [] };
  if (!root) {
    result.errors.push('No workspace folder open.');
    return result;
  }
  for (const action of plan.actions) {
    try {
      if (action.kind === 'write') {
        const target = path.join(root, action.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, action.content, { flag: 'wx' }).catch(async (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err;
          // Never clobber a file that appeared since the plan was made.
          result.errors.push(`${action.path} already exists; left unchanged.`);
        });
        result.written.push(action.path);
      } else if (action.kind === 'install') {
        const pm = profile.packageManager ?? 'npm';
        const args = pm === 'yarn' ? ['add', '-D', ...action.packages] : pm === 'bun' ? ['add', '-d', ...action.packages] : pm === 'pnpm' ? ['add', '-D', ...action.packages] : ['install', '-D', ...action.packages];
        const bin = runner.resolveBin(root, pm) ?? pm;
        const run = await runner.run(bin, args, { cwd: root, timeoutMs: 5 * 60_000 });
        if (run.code !== 0) throw new Error(`${pm} ${args.join(' ')} failed:\n${run.output}`);
        result.installed.push(...action.packages);
      } else {
        result.agents = result.agents.map(action.patch);
      }
    } catch (err) {
      result.errors.push(`${action.description}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
