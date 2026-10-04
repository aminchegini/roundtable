import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'node:path';
import type { AgentConfig } from '../shared/protocol';
import type { Runner } from './runner';
import type { EffectiveGuardrail } from './store';
import {
  MUTATING_TOOLS,
  block,
  toolFilePath,
  type HookCtx,
  type HookMap,
  type ProjectProfile,
  type RoomState,
  type ToolSpec,
  type TurnState,
} from './types';

export interface RuntimeDeps {
  profile: ProjectProfile;
  root: string;
  runner: Runner;
  /** Post a system message to the room. */
  report(text: string): void;
  /** Locks or permissions changed; host should re-apply overrides and refresh the UI. */
  stateChanged(): void;
}

export interface SpecDecisionResult {
  /** Text to post to the room as the user, so agents see it and continue. */
  userMessage: string;
}

/** Keep an agent working at most this many times per turn before letting it finish. */
const MAX_STOP_BLOCKS = 2;

/**
 * Per-room guardrail state and the per-agent hook / prompt / tool builders.
 * Owns nothing SDK-specific beyond the hook callback shapes.
 */
export class GuardrailRuntime {
  readonly room: RoomState = {
    requestId: 0,
    approvedRequest: undefined,
    spec: { status: 'none', markdown: '', agentId: '', requestId: 0 },
  };
  private effective: EffectiveGuardrail[] = [];
  private turns = new Map<string, TurnState>();

  constructor(private readonly deps: RuntimeDeps) {}

  get active(): EffectiveGuardrail[] {
    return this.effective;
  }

  setEffective(list: EffectiveGuardrail[]): void {
    this.effective = list;
  }

  has(id: string): boolean {
    return this.effective.some((g) => g.def.id === id);
  }

  // ---- room lifecycle ----

  onUserMessage(): void {
    this.room.requestId += 1;
    // Each new request needs a fresh review; an approved spec stays approved only for its own request.
    this.room.approvedRequest = undefined;
    if (this.room.spec.status !== 'none' && this.room.spec.requestId !== this.room.requestId) {
      this.room.spec = { status: 'none', markdown: '', agentId: '', requestId: this.room.requestId };
    }
    this.deps.stateChanged();
  }

  onTurnStart(agentId: string): void {
    this.turns.set(agentId, { editedFiles: new Set(), stopBlocks: 0, lastRun: new Map() });
  }

  /** Called when the user approves or rejects a submitted spec. */
  specDecision(decision: 'approve' | 'changes', note: string): SpecDecisionResult {
    const spec = this.room.spec;
    if (decision === 'approve') {
      // Approval is posted as a new user message, which bumps requestId; keep the spec bound to it.
      spec.status = 'approved';
      spec.requestId = this.room.requestId + 1;
      return { userMessage: `Spec approved${note.trim() ? `: ${note.trim()}` : ''}. Go ahead and implement it.` };
    }
    spec.status = 'changes';
    spec.requestId = this.room.requestId + 1;
    return { userMessage: `Spec needs changes${note.trim() ? `: ${note.trim()}` : ''}. Revise and submit it again.` };
  }

  /** Human-readable lock state for the UI. */
  get locks(): { review?: string; spec?: string } {
    const locks: { review?: string; spec?: string } = {};
    if (this.has('reviewer-veto') && this.room.approvedRequest !== this.room.requestId) locks.review = 'awaiting reviewer approval';
    if (this.has('spec-first')) {
      const s = this.room.spec;
      if (!(s.status === 'approved' && s.requestId === this.room.requestId)) {
        locks.spec = s.status === 'pending' ? 'spec awaiting your decision' : 'awaiting spec';
      }
    }
    return locks;
  }

  // ---- per-agent builders ----

  private ctxFor(agent: AgentConfig, roster: AgentConfig[], cwd: string, config: unknown): HookCtx {
    return {
      agent,
      roster,
      root: this.deps.root,
      cwd,
      profile: this.deps.profile,
      config,
      room: this.room,
      turn: this.turnFor(agent.id),
      runner: this.deps.runner,
      report: (text) => this.deps.report(text),
      stateChanged: () => this.deps.stateChanged(),
    };
  }

  private turnFor(agentId: string): TurnState {
    let turn = this.turns.get(agentId);
    if (!turn) {
      turn = { editedFiles: new Set(), stopBlocks: 0, lastRun: new Map() };
      this.turns.set(agentId, turn);
    }
    return turn;
  }

  buildHooks(agent: AgentConfig, roster: AgentConfig[], cwd: string): HookMap {
    const merged: HookMap = {};
    const add = (map: HookMap) => {
      for (const [event, matchers] of Object.entries(map)) {
        const key = event as keyof HookMap;
        merged[key] = [...(merged[key] ?? []), ...(matchers ?? [])];
      }
    };

    // Track files this agent edits during its turn; every gate uses the list.
    const track: HookCallback = async (input: HookInput) => {
      if (input.hook_event_name !== 'PostToolUse') return {};
      const file = toolFilePath(input.tool_input);
      if (file) this.turnFor(agent.id).editedFiles.add(relativeTo(cwd, file));
      return {};
    };
    add({ PostToolUse: [{ matcher: MUTATING_TOOLS, hooks: [track] }] });

    for (const { def, config } of this.effective) {
      if (def.hooks) add(def.hooks(this.ctxFor(agent, roster, cwd, config)));
    }

    const checks = this.effective.filter((g) => g.def.stopCheck);
    if (checks.length > 0) {
      const stop: HookCallback = async (input: HookInput) => {
        if (input.hook_event_name !== 'Stop') return {};
        const turn = this.turnFor(agent.id);
        const lastMessage = input.last_assistant_message ?? '';
        for (const { def, config } of checks) {
          const ctx = this.ctxFor(agent, roster, cwd, config);
          let reason: string | undefined;
          try {
            reason = await def.stopCheck!(ctx, lastMessage);
          } catch (err) {
            this.deps.report(`Guardrail ${def.id} failed to run for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          if (!reason) continue;
          if (turn.stopBlocks >= MAX_STOP_BLOCKS) {
            this.deps.report(`${agent.name} finished with an unmet gate (${def.title}): ${firstLine(reason)}`);
            return {};
          }
          turn.stopBlocks += 1;
          return block(`[${def.title}] ${reason}`);
        }
        return {};
      };
      add({ Stop: [{ hooks: [stop], timeout: 600 }] });
    }
    return merged;
  }

  async buildPrompt(agent: AgentConfig, roster: AgentConfig[], cwd: string): Promise<string> {
    const parts: string[] = [];
    for (const { def, config } of this.effective) {
      if (!def.prompt) continue;
      const text = await def.prompt(this.ctxFor(agent, roster, cwd, config));
      if (text.trim()) parts.push(`### ${def.title}\n${text.trim()}`);
    }
    if (parts.length === 0) return '';
    return `## Project guardrails\nThese are enforced by hooks; working around them is not an option.\n\n${parts.join('\n\n')}`;
  }

  buildTools(agent: AgentConfig, roster: AgentConfig[], cwd: string): ToolSpec[] {
    return this.effective.flatMap(({ def, config }) => def.tools?.(this.ctxFor(agent, roster, cwd, config)) ?? []);
  }

  buildDisallowed(agent: AgentConfig, roster: AgentConfig[], cwd: string): string[] {
    return this.effective.flatMap(({ def, config }) => def.disallowedTools?.(this.ctxFor(agent, roster, cwd, config)) ?? []);
  }
}

export function relativeTo(base: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.join(base, file);
  const rel = path.relative(base, abs);
  return rel.split(path.sep).join('/');
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 200) ?? '';
}
