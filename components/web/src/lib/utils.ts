export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms === 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatTime(timestamp: Date): string {
  return timestamp.toLocaleTimeString();
}

