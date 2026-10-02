import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { EFFORTS, PERMISSION_MODES, WORKSPACE_MODES, type AgentConfig } from '../shared/protocol';

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string(),
  role: z.string(),
  model: z.string().min(1),
  effort: z.enum(EFFORTS as [string, ...string[]]),
  permissionMode: z.enum(PERMISSION_MODES as [string, ...string[]]),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  workspaceMode: z.enum(WORKSPACE_MODES as [string, ...string[]]),
});

const fileSchema = z.object({ agents: z.array(agentSchema) });

const COLORS = ['#d97757', '#6a9bcc', '#788c5d', '#b58bd6', '#d4a84b', '#5fb3a8'];

export function newAgentId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function agent(index: number, name: string, model: string, role: string): AgentConfig {
  return {
    id: newAgentId(),
    name,
    color: COLORS[index % COLORS.length] ?? '#888888',
    role,
    model,
    effort: 'medium',
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    workspaceMode: 'shared',
  };
}

export function defaultAgents(): AgentConfig[] {
  return [
    agent(0, 'Ada', 'claude-fable-5-1', 'Architect. You think about structure, trade-offs, and long-term consequences, and you propose concrete designs.'),
    agent(1, 'Rex', 'claude-sonnet-5-5', 'Skeptic. You look for flaws, risks, and missing cases in what others propose, and you say so plainly.'),
    agent(2, 'Kit', 'claude-haiku-4-5-20251001', 'Pragmatist. You push for the simplest thing that works and for getting it done.'),
  ];
}

export function blankAgent(existing: AgentConfig[]): AgentConfig {
  const names = ['Sol', 'Ivy', 'Max', 'Noa', 'Zed', 'Uma'];
  const taken = new Set(existing.map((a) => a.name.toLowerCase()));
  const name = names.find((n) => !taken.has(n.toLowerCase())) ?? `Agent${existing.length + 1}`;
  return agent(existing.length, name, 'claude-sonnet-5-5', '');
}

function configPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.roundtable', 'agents.json');
}

/** Returns undefined when the file is missing; throws with a readable message when it is invalid. */
export async function loadAgents(workspaceDir: string): Promise<AgentConfig[] | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(workspaceDir), 'utf8');
  } catch {
    return undefined;
  }
  const parsed = fileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid ${configPath(workspaceDir)}: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  return parsed.data.agents as AgentConfig[];
}

export async function saveAgents(workspaceDir: string, agents: AgentConfig[]): Promise<void> {
  const file = configPath(workspaceDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ agents }, null, 2)}\n`);
}
