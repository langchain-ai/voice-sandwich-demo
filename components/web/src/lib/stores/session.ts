import { writable, derived } from "svelte/store";
import type { SessionState } from "../types";

function createSessionStore() {
  const { subscribe, set, update } = writable<SessionState>({
    connected: false,
    recording: false,
    status: "ready",
    startTime: null,
    elapsed: 0,
  });

  let timerInterval: ReturnType<typeof setInterval> | null = null;

  return {
    subscribe,

    connect() {
      update((s) => ({
        ...s,
        connected: true,
        recording: true,
        status: "listening",
        startTime: Date.now(),
        elapsed: 0,
      }));
      // Start timer
      timerInterval = setInterval(() => {
        update((s) => ({
          ...s,
          elapsed: s.startTime
            ? Math.floor((Date.now() - s.startTime) / 1000)
            : 0,
        }));
      }, 1000);
    },

    disconnect() {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      update((s) => ({
        ...s,
        connected: false,
        recording: false,
        status: "disconnected",
      }));
    },

    setStatus(status: SessionState["status"]) {
      update((s) => ({ ...s, status }));
    },

    reset() {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      set({
        connected: false,
        recording: false,
        status: "ready",
        startTime: null,
        elapsed: 0,
      });
    },
  };
}

export const session = createSessionStore();

// Derived store for formatted time
export const formattedTime = derived(session, ($session) => {
  const mins = Math.floor($session.elapsed / 60);
  const secs = $session.elapsed % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
});
