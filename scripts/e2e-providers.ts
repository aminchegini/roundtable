// Live smoke test: one DM turn per provider that is signed in on this machine.
// Costs a little on each subscription. Run: npm run e2e:providers [provider,...]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROVIDERS, ProviderRegistry } from '../src/providers/registry';
import { Workspace } from '../src/room/Workspace';
import { setVendorRoot } from '../src/providers/vendorLoader';
// ROUNDTABLE_VENDOR_ROOT lets this script exercise the bundles inside an extracted .vsix (scripts/smoke-vsix.mjs).
setVendorRoot(process.env.ROUNDTABLE_VENDOR_ROOT ?? process.cwd());
console.log('vendor bundles from', process.env.ROUNDTABLE_VENDOR_ROOT ?? process.cwd());
import type { KeyValue } from '../src/room/Workspace';

class MemoryKV implements KeyValue {
  data = new Map<string, unknown>();
  get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async set(key: string, value: unknown) {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
}

const only = process.argv[2]?.split(',').filter(Boolean);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-e2e-providers-'));
fs.writeFileSync(path.join(root, 'README.md'), '# scratch\n');
const env: Record<string, string | undefined> = { ...process.env };
delete env.ANTHROPIC_API_KEY;

const registry = new ProviderRegistry(() => env);
console.log('detecting providers…');
await registry.refresh();
for (const v of registry.views()) {
  console.log(`  ${v.id.padEnd(8)} installed=${v.installed} auth=${v.authenticated} cli=${v.cliPath ?? '-'} — ${v.detail}`);
}

const ws = await Workspace.open({
  root,
  state: new MemoryKV(),
  globalState: new MemoryKV(),
  storageDir: path.join(root, '.storage'),
  env: async () => env,
  defaults: () => ({ maxRounds: 1 }),
  log: (t) => console.log(`  log: ${t}`),
  warn: (t) => console.log(`  warn: ${t}`),
});

const results: string[] = [];
for (const provider of PROVIDERS) {
  if (only && !only.includes(provider.id)) continue;
  const status = registry.statusOf(provider.id);
  if (!status?.installed || status.authenticated === false) {
    results.push(`${provider.id}: skipped (${status?.detail ?? 'unknown'})`);
    continue;
  }
  console.log(`\n=== ${provider.title} (${provider.defaultModel}) ===`);
  const agent = await ws.addAgent(provider.id);
  await ws.saveAgent({ ...agent, role: 'Terse test agent. Follow instructions literally.', effort: 'low', permissionMode: 'acceptEdits', workspaceMode: 'read-only' });
  const dm = ws.dmWith(agent.id);
  const c = ws.controller(dm.id)!;
  ws.onControllerEvent(dm.id, (e) => {
    if (e.type === 'message') console.log(`<${e.message.from}> ${e.message.text.slice(0, 300)}`);
    if (e.type === 'activity') console.log(`  [${e.agentId}] ${e.text}`);
  });
  const started = Date.now();
  try {
    c.send('Reply with exactly: ok');
    await Promise.race([c.room.whenIdle(), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 180s')), 180_000))]);
    const first = c.state().messages.filter((m) => m.from === agent.id).at(-1)?.text ?? '(no reply)';
    c.send('Reply with exactly the single word PASS and nothing else.');
    await Promise.race([c.room.whenIdle(), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 180s')), 180_000))]);
    const passed = c.state().messages.filter((m) => m.from === agent.id).length === 1; // PASS posts nothing
    const view = c.state().agents[0]!;
    results.push(`${provider.id}: reply="${first.slice(0, 40)}" pass=${passed ? 'ok' : 'NOT PASSED'} tokens=${view.tokens.input + view.tokens.output} cost=$${view.costUsd.toFixed(3)} ${((Date.now() - started) / 1000).toFixed(0)}s`);
  } catch (err) {
    results.push(`${provider.id}: FAILED ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('\n==== summary ====');
for (const r of results) console.log(r);
ws.dispose();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
