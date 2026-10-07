// Live end-to-end check of Room + SdkAgentSession without VS Code.
// Uses the local Claude Code login and costs a few cents. Run: npm run e2e
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Room, type AgentSession } from '../src/room/Room';
import { getProvider } from '../src/providers/registry';
import { DEFAULT_LIMITS, type AgentConfig } from '../src/shared/protocol';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-e2e-'));
const claudePath = [path.join(os.homedir(), '.local/bin/claude')].find((p) => fs.existsSync(p));
const env: Record<string, string | undefined> = { ...process.env };
delete env.ANTHROPIC_API_KEY;

function agent(name: string, role: string): AgentConfig {
  return {
    id: name.toLowerCase(),
    name,
    color: '#888888',
    provider: 'claude',
    role,
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    workspaceMode: 'read-only',
  };
}

const sessions = new Map<string, AgentSession>();
const room = new Room(
  {
    getCaps: () => ({ maxRounds: 2, limits: { ...DEFAULT_LIMITS, allowApi: true } }),
    emit: (e) => {
      if (e.type === 'message') console.log(`\n<${e.message.from}> ${e.message.text}`);
    },
    createSession: (config, roster) => {
      const session = getProvider(config.provider).createSession(config, roster, {
        claudePath,
        env,
        resumeId: undefined,
        resolveCwd: async () => cwd,
        onEvent: (ev) => {
          if (ev.type === 'started') console.log(`[${config.name}] started model=${ev.model} auth=${ev.apiKeySource}`);
          if (ev.type === 'activity') console.log(`[${config.name}] ${ev.text}`);
        },
        requestPermission: async (toolName) => {
          console.log(`[${config.name}] permission requested for ${toolName} -> deny`);
          return 'deny';
        },
      });
      sessions.set(config.id, session);
      return session;
    },
  },
  [
    agent('Ada', 'You argue that tabs are better than spaces.'),
    agent('Rex', 'You argue that spaces are better than tabs.'),
  ],
);

room.postUserMessage('Tabs or spaces? One sentence each, then stop when you have nothing new.');
await room.whenIdle();
console.log('\nstatus after debate:', room.status);

// Live model switch, then a directed turn.
const ada = room.agentViews[0]!.config;
await room.saveAgent({ ...ada, model: 'claude-sonnet-5-5' });
room.postUserMessage('@Ada which model are you running on? Answer with the model id only. Rex: pass.');
await room.whenIdle();
console.log('\nfinal status:', room.status);
console.log('agent costs:', room.agentViews.map((a) => `${a.config.name}=$${a.costUsd.toFixed(3)}`).join(' '));

room.dispose();
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(0);
