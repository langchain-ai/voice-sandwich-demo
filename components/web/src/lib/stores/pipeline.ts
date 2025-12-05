import { writable, derived } from "svelte/store";
import type { TurnState, LatencyStats } from "../types";

const initialTurnState: TurnState = {
  active: false,
  turnStartTs: null,
  sttStartTs: null,
  sttEndTs: null,
  agentStartTs: null,
  agentEndTs: null,
  ttsStartTs: null,
  ttsEndTs: null,
  transcript: "",
  response: "",
};

function createTurnStore() {
  const { subscribe, set, update } = writable<TurnState>(initialTurnState);

  return {
    subscribe,

    startTurn(ts: number) {
      set({
        ...initialTurnState,
        active: true,
        turnStartTs: ts,
      });
    },

    sttStart(ts: number) {
      update((t) => ({ ...t, sttStartTs: t.sttStartTs ?? ts }));
    },

    sttEnd(ts: number, transcript: string) {
      update((t) => ({ ...t, sttEndTs: ts, transcript }));
    },

    sttChunk(transcript: string) {
      update((t) => ({ ...t, transcript }));
    },

    agentStart(ts: number) {
      update((t) => ({ ...t, agentStartTs: t.agentStartTs ?? ts }));
    },

    agentChunk(ts: number, text: string) {
      update((t) => ({
        ...t,
        agentStartTs: t.agentStartTs ?? ts,
        agentEndTs: ts,
        response: t.response + text,
      }));
    },

    ttsStart(ts: number) {
      update((t) => ({ ...t, ttsStartTs: t.ttsStartTs ?? ts }));
    },

    ttsChunk(ts: number) {
      update((t) => ({
        ...t,
        ttsStartTs: t.ttsStartTs ?? ts,
        ttsEndTs: ts,
      }));
    },

    finishTurn() {
      update((t) => ({ ...t, active: false }));
    },

    reset() {
      set(initialTurnState);
    },
  };
}

function createLatencyStore() {
  const { subscribe, set, update } = writable<LatencyStats>({
    turns: 0,
    stt: [],
    agent: [],
    tts: [],
    total: [],
  });

  return {
    subscribe,

    recordTurn(turn: TurnState) {
      const sttLatency =
        turn.sttEndTs && turn.sttStartTs
          ? turn.sttEndTs - turn.sttStartTs
          : null;
      const agentLatency =
        turn.agentEndTs && turn.agentStartTs
          ? turn.agentEndTs - turn.agentStartTs
          : null;
      const ttsLatency =
        turn.ttsEndTs && turn.ttsStartTs
          ? turn.ttsEndTs - turn.ttsStartTs
          : null;

      if (sttLatency !== null && agentLatency !== null && ttsLatency !== null) {
        update((s) => ({
          turns: s.turns + 1,
          stt: [...s.stt, sttLatency],
          agent: [...s.agent, agentLatency],
          tts: [...s.tts, ttsLatency],
          total: [...s.total, sttLatency + agentLatency + ttsLatency],
        }));
      }
    },

    reset() {
      set({ turns: 0, stt: [], agent: [], tts: [], total: [] });
    },
  };
}

export const currentTurn = createTurnStore();
export const latencyStats = createLatencyStore();

// Preserved waterfall data (kept until next turn starts)
export const waterfallData = writable<TurnState | null>(null);

// Derived stats
export const computedStats = derived(latencyStats, ($stats) => {
  if ($stats.total.length === 0) {
    return { avg: null, min: null, max: null };
  }
  const avg = $stats.total.reduce((a, b) => a + b, 0) / $stats.total.length;
  const min = Math.min(...$stats.total);
  const max = Math.max(...$stats.total);
  return { avg, min, max };
});
