import { describe, expect, it } from 'vitest';
import { Room, type AgentSession, type RoomCaps, type TurnResult } from '../src/room/Room';
import { DEFAULT_LIMITS, type AgentConfig } from '../src/shared/protocol';

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
    if (typeof reply === 'string') return { text: reply, passed: false, costUsd: this.cost, tokens: { input: Math.round(this.cost * 100), output: 0 } };
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
      getCaps: () => ({ maxRounds: 6, limits: { ...DEFAULT_LIMITS, allowApi: true }, ...caps }),
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
    const { room } = setup({ Ada: [...forever], Rex: [...forever] }, { maxRounds: 100, limits: { ...DEFAULT_LIMITS, allowApi: true, apiBudgetUsd: 0.3 } });
    room.postUserMessage('debate');
    await room.whenIdle();

    expect(room.status.stopReason).toBe('budget');
    expect(room.status.costUsd).toBeCloseTo(0.3);
  });

  it('tracks billing per agent and caps only API spend', async () => {
    const forever = Array.from({ length: 50 }, (_, i) => `m${i}`);
    const sessions: Record<string, FakeSession> = {};
    const room = new Room(
      {
        getCaps: () => ({ maxRounds: 100, limits: { ...DEFAULT_LIMITS, allowApi: true, apiBudgetUsd: 0.3 } }),
        emit: () => undefined,
        createSession: (c) => {
          const s = new FakeSession([...forever]);
          const run = s.runTurn.bind(s);
          s.runTurn = async (p) => ({
            ...(await run(p)),
            billing: c.name === 'Ada' ? 'subscription' : 'api',
            quota: c.name === 'Ada' ? [{ window: '5h', usedPercent: 40 }] : undefined,
          });
          sessions[c.id] = s;
          return s;
        },
      },
      [config('Ada'), { ...config('Rex'), limits: { ...DEFAULT_LIMITS, allowApi: true } }],
    );
    room.postUserMessage('go');
    await room.whenIdle();
    const status = room.status;
    expect(status.stopReason).toBe('budget');
    expect(status.billing).toBe('mixed');
    expect(status.quota).toEqual({ window: '5h', usedPercent: 40, agentName: 'Ada' });
    // Ada's subscription spend is excluded from the cap; Rex alone hit $0.30.
    expect(status.apiCostUsd).toBeCloseTo(0.3);
    expect(status.costUsd).toBeGreaterThan(status.apiCostUsd);
    expect(room.agentViews.map((a) => a.billing)).toEqual(['subscription', 'api']);
  });

  it('benches API-billed agents unless both room and agent allow it, and stops on room limits', async () => {
    const make = (roomLimits: Partial<typeof DEFAULT_LIMITS>, agentLimits?: Partial<typeof DEFAULT_LIMITS>) => {
      const kit = { ...config('Kit'), limits: agentLimits ? { ...DEFAULT_LIMITS, ...agentLimits } : undefined };
      const room = new Room(
        {
          getCaps: () => ({ maxRounds: 10, limits: { ...DEFAULT_LIMITS, ...roomLimits } }),
          emit: () => undefined,
          billingHint: (c) => (c.name === 'Kit' ? 'api' : 'subscription'),
          createSession: (c) => {
            const s = new FakeSession(Array.from({ length: 20 }, (_, i) => `${c.name}-${i}`));
            const run = s.runTurn.bind(s);
            s.runTurn = async (p) => ({ ...(await run(p)), billing: c.name === 'Kit' ? 'api' : 'subscription', quota: c.name === 'Ada' ? [{ window: '5h', usedPercent: 70 }] : undefined });
            return s;
          },
        },
        [config('Ada'), kit],
      );
      return room;
    };

    // Default: API off → Kit sits out with an explanation, Ada talks.
    let room = make({});
    room.postUserMessage('go');
    await room.whenIdle();
    expect(room.transcript.some((m) => m.from === 'system' && /Kit runs on an API key and API usage is off/.test(m.text))).toBe(true);
    expect(room.transcript.some((m) => m.from === 'kit')).toBe(false);
    expect(room.agentViews.find((a) => a.config.name === 'Kit')!.benched).toBe('api-not-allowed');

    // Room allows but agent does not → still benched.
    room = make({ allowApi: true });
    room.postUserMessage('go');
    await room.whenIdle();
    expect(room.transcript.some((m) => m.from === 'kit')).toBe(false);

    // Both allow → Kit speaks; agent API budget then benches it.
    room = make({ allowApi: true }, { allowApi: true, apiBudgetUsd: 0.15 });
    room.postUserMessage('go');
    await room.whenIdle();
    expect(room.transcript.filter((m) => m.from === 'kit').length).toBeGreaterThan(0);
    expect(room.transcript.some((m) => /Kit reached its API budget/.test(m.text))).toBe(true);

    // Room quota threshold stops the debate once Ada's window passes it.
    room = make({ quotaStopPercent: 60 });
    room.postUserMessage('go');
    await room.whenIdle();
    expect(room.status.stopReason).toBe('quota');

    // Room token cap (both agents allowed so both contribute tokens).
    room = make({ maxTokens: 20, allowApi: true }, { allowApi: true });
    room.postUserMessage('go');
    await room.whenIdle();
    expect(room.status.stopReason).toBe('tokens');
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
        getCaps: () => ({ maxRounds: 6, limits: { ...DEFAULT_LIMITS, allowApi: true } }),
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
