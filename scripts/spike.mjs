// M0 spike: confirm the SDK runs with the local Claude Code login (no API key).
import { query } from '@anthropic-ai/claude-agent-sdk';

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;

const q = query({
  prompt: 'Reply with exactly: ok',
  options: {
    model: 'claude-haiku-4-5-20251001',
    pathToClaudeCodeExecutable: process.env.CLAUDE_PATH,
    permissionMode: 'default',
    maxTurns: 1,
    settingSources: [],
    env,
  },
});

for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    console.log('init', { apiKeySource: m.apiKeySource, model: m.model, version: m.claude_code_version });
  } else if (m.type === 'result') {
    console.log('result', { subtype: m.subtype, result: m.result, cost: m.total_cost_usd });
  }
}
