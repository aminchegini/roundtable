import { describe, expect, it } from 'vitest';
import { Room, type AgentSession, type RoomCaps, type TurnResult } from '../src/room/Room';
import type { AgentConfig } from '../src/shared/protocol';

function config(name: string): AgentConfig {
  return {
    id: name.toLowerCase(),
    name,
    color: '#000000',
    provider: 'claude',
    role: '',
    model: 'test',
    effort: 'medium',
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    workspaceMode: 'shared',
  };
}

type Reply = string | { pass: true } | { error: string } | ((prompt: string) => string | { pass: true });

/** Scripted session: answers from a queue, then passes forever. */
class FakeSession implements AgentSession {
  prompts: string[] = [];
  cost = 0;
  constructor(private replies: Reply[], private costPerTurn = 0.1) {}

  async runTurn(prompt: string): Promise<TurnResult> {
    this.prompts.push(prompt);
    this.cost += this.costPerTurn;
    let reply = this.replies.shift() ?? { pass: true as const };
    if (typeof reply === 'function') reply = reply(prompt);
    if (typeof reply === 'string') return { text: reply, passed: false, costUsd: this.cost };
    if ('error' in reply) return { text: '', passed: false, costUsd: this.cost, error: reply.error };
    return { text: '', passed: true, costUsd: this.cost };
  }
  async interrupt(): Promise<void> {}
  async applyConfig(): Promise<void> {}
  dispose(): void {}
}

function setup(scripts: Record<string, Reply[]>, caps: Partial<RoomCaps> = {}) {
  const sessions: Record<string, FakeSession> = {};
  const configs = Object.keys(scripts).map(config);
  const room = new Room(
    {
      getCaps: () => ({ maxRounds: 6, budgetUsd: 0, ...caps }),
      emit: () => undefined,
      createSession: (c) => (sessions[c.id] = new FakeSession(scripts[c.name] ?? [])),
    },
    configs,
  );
  const speakers = () => room.transcript.filter((m) => m.from !== 'system').map((m) => `${m.from}: ${m.text}`);
  return { room, sessions, speakers };
}

describe('Room', () => {
  it('runs agents round-robin and stops when everyone passes', async () => {
    const { room, sessions, speakers } = setup({ Ada: ['a1'], Rex: ['r1'], Kit: ['k1'] });
    room.postUserMessage('hello');
    await room.whenIdle();

    expect(speakers()).toEqual(['user: hello', 'ada: a1', 'rex: r1', 'kit: k1']);
    expect(room.status.stopReason).toBe('all-passed');
    expect(room.status.running).toBe(false);
    // Rex saw the user message and Ada's reply, not his own.
    expect(sessions.rex!.prompts[0]).toBe('[User]: hello\n\n[Ada]: a1');
  });

  it('only sends each agent what it has not seen', async () => {
    const { room, sessions } = setup({ Ada: ['a1', 'a2'], Rex: ['r1'] });
    room.postUserMessage('go');
    await room.whenIdle();

    expect(sessions.ada!.prompts).toEqual(['[User]: go', '[Rex]: r1']);
    expect(sessions.rex!.prompts[1]).toBe('[Ada]: a2');
  });

  it('gives a mentioned agent the next turn', async () => {
    const { room, speakers } = setup({ Ada: ['a1'], Rex: ['r1'], Kit: ['k1'] });
    room.postUserMessage('@Kit you first');
    await room.whenIdle();

    expect(speakers().slice(0, 2)).toEqual(['user: @Kit you first', 'kit: k1']);
  });

  it('lets agents hand the turn to each other with @Name', async () => {
    const { room, speakers } = setup({ Ada: ['@Kit thoughts?'], Rex: ['r1'], Kit: ['k1'] });
    room.postUserMessage('hi');
    await room.whenIdle();

    expect(speakers().slice(0, 3)).toEqual(['user: hi', 'ada: @Kit thoughts?', 'kit: k1']);
  });

  it('stops at the round cap', async () => {
    const forever = Array.from({ length: 50 }, (_, i) => `m${i}`);
    const { room, speakers } = setup({ Ada: [...forever], Rex: [...forever] }, { maxRounds: 2 });
    room.postUserMessage('debate');
    await room.whenIdle();

    expect(room.status.stopReason).toBe('max-rounds');
    expect(speakers()).toHaveLength(1 + 4);
  });

  it('stops at the budget cap', async () => {
    const forever = Array.from({ length: 50 }, (_, i) => `m${i}`);
    const { room } = setup({ Ada: [...forever], Rex: [...forever] }, { budgetUsd: 0.3, maxRounds: 100 });
    room.postUserMessage('debate');
    await room.whenIdle();

    expect(room.status.stopReason).toBe('budget');
    expect(room.status.costUsd).toBeCloseTo(0.3);
  });

  it('resets the round counter when the user interjects', async () => {
    const forever = Array.from({ length: 50 }, (_, i) => `m${i}`);
    const { room, speakers } = setup({ Ada: [...forever], Rex: [...forever] }, { maxRounds: 1 });
    room.postUserMessage('one');
    await room.whenIdle();
    expect(room.status.stopReason).toBe('max-rounds');

    room.postUserMessage('two');
    await room.whenIdle();
    expect(speakers().filter((s) => !s.startsWith('user'))).toHaveLength(4);
  });

  it('reports a failed turn and keeps going', async () => {
    const { room, speakers } = setup({ Ada: [{ error: 'boom' }], Rex: ['r1'] });
    room.postUserMessage('hi');
    await room.whenIdle();

    expect(room.transcript.some((m) => m.from === 'system' && m.text.includes('Ada failed: boom'))).toBe(true);
    expect(speakers()).toContain('rex: r1');
  });

  it('stops when every agent fails', async () => {
    const { room } = setup({ Ada: [{ error: 'x' }], Rex: [{ error: 'y' }] });
    room.postUserMessage('hi');
    await room.whenIdle();

    expect(room.status.stopReason).toBe('all-failed');
  });

  it('discards the active reply when stopped', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const sessions: FakeSession[] = [];
    const room = new Room(
      {
        getCaps: () => ({ maxRounds: 6, budgetUsd: 0 }),
        emit: () => undefined,
        createSession: () => {
          const s = new FakeSession(['late reply']);
          const run = s.runTurn.bind(s);
          s.runTurn = async (p) => {
            await gate;
            return run(p);
          };
          s.interrupt = async () => release?.();
          sessions.push(s);
          return s;
        },
      },
      [config('Ada'), config('Rex')],
    );
    room.postUserMessage('hi');
    await Promise.resolve();
    await room.stop();

    expect(room.status.stopReason).toBe('stopped');
    expect(room.transcript.map((m) => m.text)).toEqual(['hi']);
  });
});
