import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentConfig } from '../../shared/protocol';
import { MUTATING_TOOLS, bashCommand, deny, type GuardrailDef, type HookCtx, type HookMap } from '../types';
import { READONLY_COMMANDS, READ_ONLY_DENY, matchesAny } from './shared';

interface LockConfig {
  readonlyCommands: string[];
}

/** PreToolUse hooks that refuse edits (and non-read-only shell) while `locked()` returns a reason. */
function lockHooks(ctx: HookCtx<LockConfig>, locked: () => string | undefined): HookMap {
  return {
    PreToolUse: [
      {
        matcher: MUTATING_TOOLS,
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const reason = locked();
            return reason ? deny(reason) : {};
          },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const reason = locked();
            if (!reason) return {};
            const cmd = bashCommand(input.tool_input).trim();
            return matchesAny([...READONLY_COMMANDS, ...ctx.config.readonlyCommands], cmd) ? {} : deny(`${reason} Only read-only shell commands are allowed until then.`);
          },
        ],
      },
    ],
  };
}

const lockFields = [{ key: 'readonlyCommands', label: 'Extra shell commands allowed while locked (regex)', type: 'list' as const }];

// -------------------------------------------------------------- reviewer-veto

export function reviewerOf(roster: AgentConfig[]): AgentConfig | undefined {
  return roster.find((a) => a.reviewer);
}

export const reviewerVeto: GuardrailDef<LockConfig> = {
  id: 'reviewer-veto',
  title: 'Reviewer veto',
  summary: 'One read-only reviewer agent must approve the plan before any other agent may edit. Approval resets with every message you send.',
  layer: 'process',
  fields: lockFields,
  appliesTo: () => true,
  defaults: () => ({ readonlyCommands: [] }),
  status: (_p, _c, agents) => (reviewerOf(agents) ? 'ready' : 'needs-setup'),
  setup: async (_p, _c, agents) => {
    if (reviewerOf(agents)) return [];
    const pick = agents.find((a) => /review|skeptic|critic|qa/i.test(`${a.name} ${a.role}`)) ?? agents[agents.length - 1];
    if (!pick) return [];
    return [
      {
        kind: 'agents',
        description: `Mark ${pick.name} as the reviewer (read-only)`,
        patch: (a) => (a.id === pick.id ? { ...a, reviewer: true, workspaceMode: 'read-only' } : a),
      },
    ];
  },
  hooks: (ctx) => {
    if (ctx.agent.reviewer) return {};
    return lockHooks(ctx, () => {
      if (ctx.room.approvedRequest === ctx.room.requestId) return undefined;
      const reviewer = reviewerOf(ctx.roster);
      return `Edits are locked until ${reviewer?.name ?? 'the reviewer'} approves the plan for this request. Propose your approach in the room and @${reviewer?.name ?? 'reviewer'} for approval.`;
    });
  },
  tools: (ctx) => {
    if (!ctx.agent.reviewer) return [];
    return [
      {
        name: 'approve_plan',
        description: 'Approve the current plan so the other agents may start editing. Call only when the approach is sound.',
        schema: { summary: z.string().describe('One or two sentences: what is approved and any conditions.') },
        handler: async (args) => {
          ctx.room.approvedRequest = ctx.room.requestId;
          ctx.report(`${ctx.agent.name} approved the plan: ${String(args.summary ?? '')}`);
          ctx.stateChanged();
          return 'Plan approved. Other agents may now edit. Say so in your reply and hand over with @Name.';
        },
      },
    ];
  },
  disallowedTools: (ctx) => (ctx.agent.reviewer ? READ_ONLY_DENY : []),
  prompt: (ctx) => {
    const reviewer = reviewerOf(ctx.roster);
    if (ctx.agent.reviewer) {
      return 'You are the reviewer. You cannot edit files. Other agents cannot edit until you call approve_plan for the current request. Approve when the plan is sound and small enough; otherwise say exactly what must change. Re-approval is needed after every new user message.';
    }
    return `${reviewer?.name ?? 'The reviewer'} must approve the plan before you can edit anything. State your plan briefly, @${reviewer?.name ?? 'reviewer'} it, and wait.`;
  },
};

// ----------------------------------------------------------------- spec-first

export const specFirst: GuardrailDef<LockConfig> = {
  id: 'spec-first',
  title: 'Spec first',
  summary: 'Agents must submit a spec (requirements, design, tasks) that you approve in the room before any code changes.',
  layer: 'process',
  fields: lockFields,
  appliesTo: () => true,
  defaults: () => ({ readonlyCommands: [] }),
  status: () => 'ready',
  hooks: (ctx) =>
    lockHooks(ctx, () => {
      const spec = ctx.room.spec;
      if (spec.status === 'approved' && spec.requestId === ctx.room.requestId) return undefined;
      return spec.status === 'pending'
        ? 'A spec is waiting for the user to approve it; no edits until then.'
        : 'No approved spec for this request. Agree on a spec in the room and submit it with submit_spec before editing.';
    }),
  tools: (ctx) => [
    {
      name: 'submit_spec',
      description: 'Submit the spec for the current request to the user for approval. Markdown with sections: Requirements, Design, Tasks.',
      schema: { markdown: z.string().describe('The full spec in Markdown.') },
      handler: async (args) => {
        ctx.room.spec = { status: 'pending', markdown: String(args.markdown ?? ''), agentId: ctx.agent.id, requestId: ctx.room.requestId };
        ctx.report(`${ctx.agent.name} submitted a spec — waiting for your decision.`);
        ctx.stateChanged();
        return 'Spec submitted. The user will approve it or ask for changes; pass your turn until then.';
      },
    },
  ],
  prompt: (ctx) => {
    const spec = ctx.room.spec;
    const state =
      spec.status === 'approved' && spec.requestId === ctx.room.requestId
        ? 'The current spec is approved; implement it and nothing else.'
        : spec.status === 'pending'
          ? 'A spec is awaiting the user. Do not edit; pass your turn unless the user asks something.'
          : 'No approved spec yet.';
    return `Work is spec-first. Before any code change for a request, one agent submits a spec with submit_spec (Requirements, Design, Tasks — short and concrete). Discuss until the room agrees, then submit once. ${state}`;
  },
};

// --------------------------------------------------- worktree-per-implementer

interface WorktreeConfig {
  branchPrefix: string;
}

export const worktreePerImplementer: GuardrailDef<WorktreeConfig> = {
  id: 'worktree-per-implementer',
  title: 'Worktree per implementer',
  summary: 'Every agent that can edit works in its own git worktree and commits on its own branch; the shared folder stays clean.',
  layer: 'process',
  fields: [{ key: 'branchPrefix', label: 'Branch prefix', type: 'text' }],
  appliesTo: (p) => p.git,
  defaults: () => ({ branchPrefix: 'roundtable/' }),
  status: (_p, _c, agents) => (agents.every((a) => a.reviewer || a.workspaceMode === 'worktree') ? 'ready' : 'needs-setup'),
  setup: async (_p, _c, agents) => {
    const names = agents.filter((a) => !a.reviewer && a.workspaceMode !== 'worktree').map((a) => a.name);
    if (names.length === 0) return [];
    return [
      {
        kind: 'agents',
        description: `Switch ${names.join(', ')} to worktree mode`,
        patch: (a) => (a.reviewer || a.workspaceMode === 'worktree' ? a : { ...a, workspaceMode: 'worktree' }),
      },
    ];
  },
  prompt: (ctx) =>
    ctx.agent.workspaceMode === 'worktree'
      ? `You work in your own git worktree. Commit your work on a branch named ${ctx.config.branchPrefix}${ctx.agent.name.toLowerCase()}/<short-slug> (create it with git switch -c if needed). Never push without being asked.`
      : '',
};
