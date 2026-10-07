import type { AgentConfig, GuardrailOverrides, GuardrailsFile, GuardrailsView } from '../shared/protocol';
import { CATALOG } from './catalog';
import { describeProfile, detectProject } from './detect';
import { PRESETS } from './presets';
import type { Runner } from './runner';
import { GuardrailRuntime, type RuntimeDeps } from './runtime';
import { applySetup, describeSetup, planSetup, type ApplyResult, type SetupPlan } from './setup';
import { EMPTY_FILE, loadGuardrailsFile, previewConfig, resolveGuardrails, saveGuardrailsFile, type EffectiveGuardrail } from './store';
import type { ProjectProfile } from './types';

/**
 * Workspace-level guardrail state: detected profile, guardrails.json, the
 * effective set and pending setup. Rooms get their own GuardrailRuntime,
 * which this registry keeps in sync when the set changes.
 */
export class GuardrailRegistry {
  profile: ProjectProfile;
  file: GuardrailsFile = { ...EMPTY_FILE };
  effective: EffectiveGuardrail[] = [];
  setupPlan: SetupPlan = { actions: [] };
  busy = false;
  /** Runtimes and the room file each one follows (undefined = workspace file). */
  private runtimes = new Map<GuardrailRuntime, () => GuardrailsFile | undefined>();

  constructor(
    readonly root: string,
    private readonly runner: Runner,
  ) {
    this.profile = detectProject(root);
  }

  async load(agents: AgentConfig[]): Promise<void> {
    this.file = await loadGuardrailsFile(this.root);
    await this.refresh(agents);
  }

  /** Re-detect the project, resolve the effective set, recompute setup, and push to runtimes. */
  async refresh(agents: AgentConfig[]): Promise<void> {
    this.profile = detectProject(this.root);
    this.effective = resolveGuardrails(this.file, PRESETS, CATALOG, this.profile);
    this.setupPlan = await planSetup(this.effective, this.profile, agents);
    for (const [rt, roomFile] of this.runtimes) {
      rt.setProfile(this.profile);
      this.pushEffective(rt, roomFile());
    }
  }

  /** Effective set for a file (room-specific or the workspace one). */
  resolve(file: GuardrailsFile, overrides?: GuardrailOverrides): EffectiveGuardrail[] {
    return resolveGuardrails(file, PRESETS, CATALOG, this.profile, overrides);
  }

  private pushEffective(rt: GuardrailRuntime, roomFile: GuardrailsFile | undefined): void {
    const file = roomFile ?? this.file;
    rt.setEffective(roomFile ? this.resolve(file) : this.effective, (overrides) => this.resolve(file, overrides));
  }

  /** A room changed its own guardrails file (or went back to inheriting). */
  roomFileChanged(rt: GuardrailRuntime): void {
    const roomFile = this.runtimes.get(rt);
    if (roomFile) this.pushEffective(rt, roomFile());
  }

  async setFile(file: GuardrailsFile, agents: AgentConfig[]): Promise<void> {
    this.file = file;
    await saveGuardrailsFile(this.root, file);
    await this.refresh(agents);
  }

  async runSetup(agents: AgentConfig[]): Promise<ApplyResult> {
    this.busy = true;
    try {
      return await applySetup(this.setupPlan, this.profile, agents, this.runner);
    } finally {
      this.busy = false;
    }
  }

  createRuntime(deps: Pick<RuntimeDeps, 'report' | 'stateChanged'>, roomFile: () => GuardrailsFile | undefined = () => undefined): GuardrailRuntime {
    const rt = new GuardrailRuntime({ profile: this.profile, root: this.root, runner: this.runner, ...deps });
    this.runtimes.set(rt, roomFile);
    this.pushEffective(rt, roomFile());
    return rt;
  }

  releaseRuntime(rt: GuardrailRuntime): void {
    this.runtimes.delete(rt);
  }

  /** View of the workspace file, or of a room's own file when given. */
  view(agents: AgentConfig[], roomFile?: GuardrailsFile): GuardrailsView {
    const file = roomFile ?? this.file;
    const effective = roomFile ? this.resolve(roomFile) : this.effective;
    const activeIds = new Set(effective.map((g) => g.def.id));
    return {
      profile: describeProfile(this.profile),
      hasWorkspace: true,
      presets: PRESETS.map((p) => ({ id: p.id, title: p.title, summary: p.summary, guardrailIds: Object.keys(p.guardrails) })),
      file,
      entries: CATALOG.map((def) => {
        const config = previewConfig(file, PRESETS, def, this.profile);
        const applies = def.appliesTo(this.profile);
        return {
          id: def.id,
          title: def.title,
          summary: def.summary,
          layer: def.layer,
          applies,
          enabled: activeIds.has(def.id),
          status: applies ? def.status(this.profile, config, agents) : 'ready',
          config,
          fields: def.fields,
        };
      }),
      setup: describeSetup(this.setupPlan),
      busy: this.busy,
    };
  }
}

export function emptyGuardrailsView(): GuardrailsView {
  return { profile: 'No folder open — guardrails need a workspace.', hasWorkspace: false, presets: [], file: { ...EMPTY_FILE }, entries: [], setup: [], busy: false };
}
