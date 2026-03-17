<script lang="ts">
  import { session } from '../stores';

  interface Props {
    onToggle: () => void;
    onPlayLast: () => void;
  }

  let { onToggle, onPlayLast }: Props = $props();

  const statusConfig = {
    ready: { dot: 'bg-cyan-400 shadow-[0_0_8px_theme(colors.cyan.400)]', text: 'Ready' },
    connecting: { dot: 'bg-gray-400', text: 'Connecting...' },
    listening: { dot: 'bg-red-500 shadow-[0_0_8px_theme(colors.red.500)] animate-pulse', text: 'Listening...' },
    processing: { dot: 'bg-amber-400 shadow-[0_0_8px_theme(colors.amber.400)] animate-pulse', text: 'Processing...' },
    error: { dot: 'bg-red-500', text: 'Error' },
    disconnected: { dot: 'bg-gray-400', text: 'Disconnected' },
  };

  let config = $derived(statusConfig[$session.status]);
</script>

<div class="bg-white rounded-2xl p-6 mb-5 border border-gray-200">
  <div class="mb-5 flex justify-center">
    <button
      onclick={onToggle}
      disabled={$session.status === 'connecting' || $session.status === 'processing'}
      class="w-36 h-36 rounded-full text-base font-semibold bg-gray-900 text-white
             flex flex-col items-center justify-center gap-2 transition-all duration-200
             hover:bg-gray-700 hover:-translate-y-0.5 hover:shadow-lg
             disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
        <line x1="12" y1="19" x2="12" y2="23"></line>
        <line x1="8" y1="23" x2="16" y2="23"></line>
      </svg>
      {$session.recording ? 'Stop' : 'Speak'}
    </button>
  </div>
  <div class="flex items-center gap-2 py-2.5 px-3.5 bg-gray-100 rounded-lg">
    <span class="w-2.5 h-2.5 rounded-full shrink-0 transition-all duration-300 {config.dot}"></span>
    <span class="text-sm font-medium text-gray-600 flex-1">{config.text}</span>
    <button
      onclick={onPlayLast}
      class="py-1.5 px-3 text-xs font-medium bg-white text-gray-700 rounded-md border border-gray-300
             transition-all duration-200 hover:bg-gray-200 hover:border-gray-400"
    >
      Play last
    </button>
  </div>

  {#if $session.connected}
    <div class="mt-3 py-2.5 px-3.5 bg-cyan-400/10 border border-cyan-400/20 rounded-lg text-xs text-gray-600 text-center">
      💡 Session is active — just speak naturally. End session when you're done.
    </div>
  {/if}
</div>

