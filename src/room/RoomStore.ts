import type { RoomMeta } from '../shared/protocol';

export interface RoomStoreData {
  rooms: RoomMeta[];
  activeRoomId?: string;
}

export function newRoomId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Room metadata: create, rename, pin, delete, participants, active room. Persists through `save`. */
export class RoomStore {
  private data: RoomStoreData;
  private listeners = new Set<() => void>();

  constructor(data: RoomStoreData | undefined, private readonly save: (data: RoomStoreData) => void) {
    this.data = { rooms: data?.rooms ?? [], activeRoomId: data?.activeRoomId };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Pinned first, then most recent activity. */
  list(): RoomMeta[] {
    return [...this.data.rooms].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivity - a.lastActivity);
  }

  get(id: string): RoomMeta | undefined {
    return this.data.rooms.find((r) => r.id === id);
  }

  get activeRoomId(): string | undefined {
    return this.data.activeRoomId && this.get(this.data.activeRoomId) ? this.data.activeRoomId : this.list()[0]?.id;
  }

  /** The DM room for an agent, if one exists. */
  dmFor(agentId: string): RoomMeta | undefined {
    return this.data.rooms.find((r) => r.kind === 'dm' && r.agentIds[0] === agentId);
  }

  create(input: { name: string; kind: 'group' | 'dm'; agentIds: string[]; id?: string }): RoomMeta {
    const now = Date.now();
    const room: RoomMeta = {
      id: input.id ?? newRoomId(),
      name: input.name.trim() || (input.kind === 'dm' ? 'Direct message' : 'New room'),
      kind: input.kind,
      agentIds: input.kind === 'dm' ? input.agentIds.slice(0, 1) : [...new Set(input.agentIds)],
      pinned: false,
      createdAt: now,
      lastActivity: now,
    };
    this.data.rooms.push(room);
    this.data.activeRoomId = room.id;
    this.commit();
    return room;
  }

  rename(id: string, name: string): void {
    this.update(id, (r) => ({ ...r, name: name.trim() || r.name }));
  }

  pin(id: string, pinned: boolean): void {
    this.update(id, (r) => ({ ...r, pinned }));
  }

  setParticipants(id: string, agentIds: string[]): void {
    this.update(id, (r) => (r.kind === 'dm' ? r : { ...r, agentIds: [...new Set(agentIds)] }));
  }

  /** Drop an agent from every room; DMs with that agent are deleted. */
  removeAgentEverywhere(agentId: string): string[] {
    const deleted = this.data.rooms.filter((r) => r.kind === 'dm' && r.agentIds[0] === agentId).map((r) => r.id);
    this.data.rooms = this.data.rooms
      .filter((r) => !deleted.includes(r.id))
      .map((r) => (r.agentIds.includes(agentId) ? { ...r, agentIds: r.agentIds.filter((a) => a !== agentId) } : r));
    this.commit();
    return deleted;
  }

  /** Update room-level settings (limits, rounds, custom guardrails). `null` clears a field. */
  patch(id: string, patch: { limits?: RoomMeta['limits']; maxRounds?: number | null; guardrails?: RoomMeta['guardrails'] | null; mode?: RoomMeta['mode'] | null; name?: string }): void {
    this.update(id, (r) => {
      const next = { ...r };
      if (patch.mode !== undefined) {
        if (patch.mode === null) delete next.mode;
        else next.mode = patch.mode;
      }
      if (patch.limits !== undefined) next.limits = patch.limits;
      if (patch.maxRounds !== undefined) {
        if (patch.maxRounds === null) delete next.maxRounds;
        else next.maxRounds = patch.maxRounds;
      }
      if (patch.guardrails !== undefined) {
        if (patch.guardrails === null) delete next.guardrails;
        else next.guardrails = patch.guardrails;
      }
      if (patch.name?.trim()) next.name = patch.name.trim();
      return next;
    });
  }

  touch(id: string, lastMessage?: RoomMeta['lastMessage']): void {
    this.update(id, (r) => ({ ...r, lastActivity: Date.now(), ...(lastMessage ? { lastMessage: { ...lastMessage, text: lastMessage.text.slice(0, 120) } } : {}) }));
  }

  remove(id: string): void {
    this.data.rooms = this.data.rooms.filter((r) => r.id !== id);
    if (this.data.activeRoomId === id) this.data.activeRoomId = this.list()[0]?.id;
    this.commit();
  }

  setActive(id: string): void {
    if (!this.get(id)) return;
    this.data.activeRoomId = id;
    this.commit();
  }

  private update(id: string, fn: (room: RoomMeta) => RoomMeta): void {
    const index = this.data.rooms.findIndex((r) => r.id === id);
    const room = this.data.rooms[index];
    if (!room) return;
    this.data.rooms[index] = fn(room);
    this.commit();
  }

  private commit(): void {
    this.save({ rooms: this.data.rooms, activeRoomId: this.data.activeRoomId });
    for (const l of this.listeners) l();
  }
}
