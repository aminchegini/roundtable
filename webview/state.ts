import type {
  AgentView,
  GuardrailsView,
  HostToWebview,
  PermissionRequest,
  ProviderView,
  RoomMessage,
  RoomState,
  RoomStatus,
  RoomsView,
  SpecView,
  WebviewToHost,
} from '../src/shared/protocol';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };
const vscode = acquireVsCodeApi();
export const post = (message: WebviewToHost) => vscode.postMessage(message);

export interface Live {
  text: string;
  activity: string;
}

export type View = 'room' | 'guardrails' | 'help';

export interface State {
  loaded: boolean;
  location: 'sidebar' | 'editor';
  view: View;
  rooms: RoomsView;
  allAgents: AgentView[];
  providers: ProviderView[];
  guardrails: GuardrailsView;
  /** Active room, or undefined when the workspace has no rooms. */
  roomState: RoomState | undefined;
  /** Streaming text and tool activity for agents mid-turn, by agent id. */
  live: Record<string, Live>;
}

export const EMPTY_STATUS: RoomStatus = { running: false, round: 0, maxRounds: 0, costUsd: 0, apiCostUsd: 0, billing: 'unknown', tokens: { input: 0, output: 0 }, budgetUsd: 0 };

export const initial: State = {
  loaded: false,
  location: 'sidebar',
  view: 'room',
  rooms: { rooms: [], activeRoomId: undefined },
  allAgents: [],
  providers: [],
  guardrails: { profile: '', hasWorkspace: false, presets: [], file: { enabled: {}, disabled: [] }, entries: [], setup: [], busy: false },
  roomState: undefined,
  live: {},
};

export type Action = HostToWebview | { type: 'setView'; view: View };

function patchRoom(state: State, patch: Partial<RoomState>): State {
  if (!state.roomState) return state;
  return { ...state, roomState: { ...state.roomState, ...patch } };
}

export function reduce(state: State, m: Action): State {
  switch (m.type) {
    case 'state':
      return {
        ...state,
        loaded: true,
        location: m.location,
        rooms: m.rooms,
        allAgents: m.allAgents,
        providers: m.providers,
        guardrails: m.guardrails,
        roomState: m.roomState,
        live: {},
      };
    case 'setView':
      return { ...state, view: m.view };
    case 'navigate':
      return { ...state, view: m.view };
    case 'rooms':
      return { ...state, rooms: m.rooms };
    case 'allAgents':
      return { ...state, allAgents: m.agents };
    case 'providers':
      return { ...state, providers: m.providers };
    case 'guardrails':
      return { ...state, guardrails: m.guardrails };
    case 'message': {
      if (!state.roomState) return state;
      const live = { ...state.live };
      delete live[m.message.from];
      return { ...patchRoom(state, { messages: [...state.roomState.messages, m.message] }), live };
    }
    case 'partial':
      return { ...state, live: { ...state.live, [m.agentId]: { text: m.text, activity: '' } } };
    case 'activity':
      return { ...state, live: { ...state.live, [m.agentId]: { text: state.live[m.agentId]?.text ?? '', activity: m.text } } };
    case 'agents': {
      const speaking = new Set(m.agents.filter((a) => a.status === 'speaking').map((a) => a.config.id));
      const live = Object.fromEntries(Object.entries(state.live).filter(([id]) => speaking.has(id)));
      return { ...patchRoom(state, { agents: m.agents }), live };
    }
    case 'room':
      return patchRoom(state, { room: m.room });
    case 'permissions':
      return patchRoom(state, { permissions: m.permissions });
    case 'spec':
      return patchRoom(state, { spec: m.spec });
  }
}

export type { AgentView, PermissionRequest, ProviderView, RoomMessage, SpecView };
