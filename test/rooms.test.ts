import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCursorEvent, type CursorAcc } from '../src/providers/cursor';
import { applyGeminiEvent, type TurnAcc } from '../src/providers/gemini';
import { PROVIDERS, ProviderRegistry } from '../src/providers/registry';
import { isAuthError, type Provider } from '../src/providers/types';
import type { AgentSession, TurnResult } from '../src/room/Room';
import { RoomStore } from '../src/room/RoomStore';
import { parseReply, textProtocolPrompt } from '../src/room/textCommands';
import { Workspace, type KeyValue } from '../src/room/Workspace';
import type { AgentConfig } from '../src/shared/protocol';

// ---- helpers ----

class MemoryKV implements KeyValue {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

/** Scripted sessions for a fake provider, keyed by agent name. */
const scripts = new Map<string, Array<string | ((prompt: string) => string)>>();
const prompts = new Map<string, string[]>();

class FakeSession implements AgentSession {
  constructor(private readonly agent: AgentConfig) {}
  async runTurn(prompt: string): Promise<TurnResult> {
    prompts.set(this.agent.name, [...(prompts.get(this.agent.name) ?? []), prompt]);
    const next = scripts.get(this.agent.name)?.shift() ?? 'PASS';
    const text = typeof next === 'function' ? next(prompt) : next;
    return { text, passed: false, costUsd: 0, tokens: { input: 10, output: 5 } };
  }
  async interrupt() {}
  async applyConfig() {}
  dispose() {}
}

const fakeProvider: Provider = {
  id: 'cursor', // reuse an id the registry knows; tests override its factory
  title: 'Fake',
  vendor: 'test',
  enforcement: 'gates',
  costUsd: false,
  defaultModel: 'fake-1',
  loginCommand: 'fake login',
  staticModels: [{ id: 'fake-1', label: 'fake' }],
  detect: async () => ({ installed: true, authenticated: true, detail: 'fake', setupHint: '' }),
  createSession: (agent) => new FakeSession(agent),
};
const realCursor = PROVIDERS.find((p) => p.id === 'cursor')!;

function patchProvider(): () => void {
  const index = PROVIDERS.indexOf(realCursor);
  PROVIDERS[index] = fakeProvider;
  return () => {
    PROVIDERS[index] = realCursor;
  };
}

async function openWorkspace(root: string | undefined, state = new MemoryKV()) {
  const ws = await Workspace.open({
    root,
    state,
    globalState: new MemoryKV(),
    storageDir: path.join(os.tmpdir(), 'rt-storage'),
    env: async () => ({}),
    claudePath: undefined,
    caps: () => ({ maxRounds: 3, budgetUsd: 0 }),
    log: () => undefined,
    warn: () => undefined,
  });
  return { ws, state };
}

const tmp: string[] = [];
afterEach(() => {
  for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  scripts.clear();
  prompts.clear();
});

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-rooms-'));
  tmp.push(dir);
  return dir;
}

// ---- tests ----

describe('textCommands', () => {
  it('recognises PASS, APPROVE and SPEC', () => {
    expect(parseReply('PASS')).toEqual({ text: '', passed: true });
    expect(parseReply('**PASS**.')).toMatchObject({ passed: true });
    expect(parseReply('Looks fine.\nAPPROVE: small, safe change')).toMatchObject({ text: 'Looks fine.', approve: 'small, safe change' });
    const spec = parseReply('Here is my proposal.\n\nSPEC:\n```markdown\n## Requirements\n- a\n```\n');
    expect(spec.spec).toBe('## Requirements\n- a');
    expect(spec.text).toBe('Here is my proposal.');
    expect(parseReply('just a normal reply with pass in it')).toMatchObject({ passed: false, text: 'just a normal reply with pass in it' });
  });

  it('describes the protocol to agents without tools', () => {
    expect(textProtocolPrompt({ reviewer: true, specFirst: true })).toMatch(/PASS[\s\S]*APPROVE[\s\S]*SPEC/);
    expect(textProtocolPrompt({ reviewer: false, specFirst: false })).not.toMatch(/APPROVE/);
  });
});

describe('RoomStore', () => {
  it('creates, renames, pins, orders and deletes rooms', () => {
    const saved: unknown[] = [];
    const store = new RoomStore(undefined, (d) => saved.push(d));
    const a = store.create({ name: 'A', kind: 'group', agentIds: ['x', 'y'] });
    const b = store.create({ name: 'B', kind: 'group', agentIds: ['x'] });
    const dm = store.create({ name: '', kind: 'dm', agentIds: ['x', 'y'] });
    expect(dm.agentIds).toEqual(['x']);
    expect(dm.name).toBe('Direct message');
    expect(store.activeRoomId).toBe(dm.id);
    store.pin(a.id, true);
    expect(store.list()[0]!.id).toBe(a.id);
    store.rename(b.id, 'Better');
    expect(store.get(b.id)!.name).toBe('Better');
    expect(store.dmFor('x')!.id).toBe(dm.id);
    expect(store.removeAgentEverywhere('x')).toEqual([dm.id]);
    expect(store.get(a.id)!.agentIds).toEqual(['y']);
    store.remove(a.id);
    expect(store.activeRoomId).toBe(b.id);
    expect(saved.length).toBeGreaterThan(5);
  });
});

describe('Workspace', () => {
  it('creates a General room on first open and migrates a v2 single-room snapshot', async () => {
    const state = new MemoryKV();
    await state.set('roundtable.snapshot', { messages: [{ id: 1, from: 'user', text: 'old', ts: 1 }], costs: {} });
    await state.set('roundtable.sessions', { a: 's1' });
    const { ws } = await openWorkspace(undefined, state);
    const rooms = ws.rooms.list();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.name).toBe('General');
    expect(rooms[0]!.agentIds).toHaveLength(ws.agents.length);
    expect(state.get('roundtable.snapshot')).toBeUndefined();
    const controller = ws.controller(rooms[0]!.id)!;
    expect(controller.state().messages.map((m) => m.text)).toEqual(['old']);
    ws.dispose();
  });

  it('DMs reach only one agent, rooms keep separate memory, participants sync', async () => {
    const restore = patchProvider();
    try {
      const { ws } = await openWorkspace(tmpdir());
      for (const a of ws.agents) await ws.saveAgent({ ...a, provider: 'cursor' });
      const [ada, rex] = ws.agents;
      scripts.set(ada!.name, ['hello from the room']);
      scripts.set(rex!.name, ['PASS']);

      const general = ws.rooms.list()[0]!;
      const room = ws.controller(general.id)!;
      room.send('hi everyone');
      await room.room.whenIdle();
      expect(room.state().messages.filter((m) => m.from !== 'user' && m.from !== 'system').map((m) => m.text)).toEqual(['hello from the room']);

      const dm = ws.dmWith(rex!.id);
      expect(dm.kind).toBe('dm');
      expect(ws.rooms.activeRoomId).toBe(dm.id);
      scripts.set(rex!.name, ['only me here']);
      const dmController = ws.controller(dm.id)!;
      dmController.send('just you');
      await dmController.room.whenIdle();
      expect(dmController.state().agents).toHaveLength(1);
      expect(dmController.state().messages.at(-1)!.text).toBe('only me here');
      // The DM digest did not include the room conversation.
      expect(prompts.get(rex!.name)!.at(-1)).toBe('[User]: just you');
      // Same DM is reused.
      expect(ws.dmWith(rex!.id).id).toBe(dm.id);

      await ws.setParticipants(general.id, [ada!.id]);
      expect(room.state().agents.map((a) => a.config.name)).toEqual([ada!.name]);

      await ws.removeAgent(rex!.id);
      expect(ws.rooms.get(dm.id)).toBeUndefined();
      expect(ws.agents.map((a) => a.id)).not.toContain(rex!.id);
      ws.dispose();
    } finally {
      restore();
    }
  });

  it('enforces stop gates after the turn for providers without hooks', async () => {
    const restore = patchProvider();
    try {
      const root = tmpdir();
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      const { ws } = await openWorkspace(root);
      await ws.setGuardrails({ enabled: { 'definition-of-done': { require: true } }, disabled: [] });
      const kit = ws.agents[2]!;
      await ws.saveAgent({ ...kit, provider: 'cursor' });
      const dm = ws.dmWith(kit.id);
      const c = ws.controller(dm.id)!;
      // First reply lacks the DoD line after an "edit"; the gate asks again; second reply complies.
      scripts.set(kit.name, [
        () => {
          c['runtime']!.noteEdit(kit.id, root, 'src/a.ts');
          return 'Changed a.ts, done.';
        },
        'Changed a.ts.\nDoD: tests pass',
      ]);
      c.send('change a.ts');
      await c.room.whenIdle();
      expect(prompts.get(kit.name)).toHaveLength(2);
      expect(prompts.get(kit.name)![1]).toMatch(/\[Definition of done\]/);
      expect(c.state().messages.at(-1)!.text).toBe('Changed a.ts.\nDoD: tests pass');
      ws.dispose();
    } finally {
      restore();
    }
  });
});

describe('login detection', () => {
  it('recognises vendor sign-in failures and ignores ordinary errors', () => {
    expect(isAuthError('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
    expect(isAuthError('Error: not logged in. Run codex login.')).toBe(true);
    expect(isAuthError('HTTP 401 Unauthorized')).toBe(true);
    expect(isAuthError('error_max_turns')).toBe(false);
    expect(isAuthError('ENOENT: gemini not found')).toBe(false);
  });

  it('retries the last user message after a sign-in', async () => {
    const restore = patchProvider();
    try {
      const { ws } = await openWorkspace(tmpdir());
      const kit = ws.agents[2]!;
      await ws.saveAgent({ ...kit, provider: 'cursor' });
      const dm = ws.dmWith(kit.id);
      const c = ws.controller(dm.id)!;
      scripts.set(kit.name, ['first', 'second']);
      c.send('hello again');
      await c.room.whenIdle();
      expect(await ws.retryAfterLogin(dm.id)).toBe(true);
      await c.room.whenIdle();
      expect(prompts.get(kit.name)).toEqual(['[User]: hello again', '[User]: hello again']);
      expect(c.state().messages.filter((m) => m.from === 'user')).toHaveLength(2);
      ws.dispose();
    } finally {
      restore();
    }
  });
});

describe('provider event reducers', () => {
  it('maps Gemini stream-json events', () => {
    const acc: TurnAcc = { text: '' };
    const seen: string[] = [];
    const hooks = { started: (id: string) => seen.push(`start:${id}`), partial: (t: string) => seen.push(`p:${t}`), activity: (t: string) => seen.push(`a:${t}`), edited: (f: string) => seen.push(`e:${f}`) };
    applyGeminiEvent(acc, { type: 'init', session_id: 'g1', model: 'gemini-3-pro-preview' }, hooks);
    applyGeminiEvent(acc, { type: 'message', role: 'assistant', content: 'Hel', delta: true }, hooks);
    applyGeminiEvent(acc, { type: 'message', role: 'assistant', content: 'lo', delta: true }, hooks);
    applyGeminiEvent(acc, { type: 'tool_use', tool_name: 'write_file', parameters: { file_path: 'src/x.ts' } }, hooks);
    const tokens = applyGeminiEvent(acc, { type: 'result', status: 'success', stats: { input_tokens: 12, output_tokens: 3 } }, hooks);
    expect(acc.text).toBe('Hello');
    expect(tokens).toEqual({ input: 12, output: 3 });
    expect(seen).toContain('start:g1');
    expect(seen).toContain('e:src/x.ts');
  });

  it('maps Cursor stream-json events', () => {
    const acc: CursorAcc = { text: '', streamed: '' };
    const seen: string[] = [];
    const hooks = { started: (id: string) => seen.push(id), partial: () => undefined, activity: (t: string) => seen.push(t), edited: (f: string) => seen.push(f) };
    applyCursorEvent(acc, { type: 'system', subtype: 'init', session_id: 'c1', model: 'sonnet-4.5' }, hooks);
    applyCursorEvent(acc, { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi ' }] } }, hooks);
    applyCursorEvent(acc, { type: 'tool_call', subtype: 'started', tool_call: { name: 'edit_file', args: { path: 'a.ts' } } }, hooks);
    applyCursorEvent(acc, { type: 'result', subtype: 'success', result: 'Hi there', is_error: false }, hooks);
    expect(acc.text).toBe('Hi there');
    expect(seen).toEqual(['c1', 'edit_file', 'a.ts']);
  });

  it('registry merges static and detected models and reports availability', async () => {
    const restore = patchProvider();
    try {
      const registry = new ProviderRegistry(() => ({}));
      expect(registry.models('cursor').map((m) => m.id)).toEqual(['fake-1']);
      await registry.refresh();
      const view = registry.views().find((v) => v.id === 'cursor')!;
      expect(view.authenticated).toBe(true);
      expect(registry.usable({ provider: 'cursor' } as AgentConfig)).toBe(true);
    } finally {
      restore();
    }
  });
});
