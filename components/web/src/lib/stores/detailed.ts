import { writable } from "svelte/store";

export interface DetailedItem {
  id: string;
  taskId: number | null;
  text: string;
  ts: number;
}

function createDetailedStore() {
  const { subscribe, set, update } = writable<DetailedItem[]>([]);
  let idCounter = 0;

  return {
    subscribe,
    append(taskId: number | null, text: string, ts: number) {
      update((items) => [
        {
          id: `detail-${++idCounter}`,
          taskId,
          text,
          ts,
        },
        ...items,
      ].slice(0, 200));
    },
    clear() {
      set([]);
    },
  };
}

export const detailedStream = createDetailedStore();

