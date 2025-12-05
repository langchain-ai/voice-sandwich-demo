<script lang="ts">
  import { logs } from '../stores';
  import { formatTime } from '../utils';
</script>

<div class="bg-white rounded-2xl p-6 border border-gray-200">
  <div class="flex items-center justify-between mb-4">
    <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Console</span>
  </div>

  <div class="max-h-44 overflow-y-auto font-mono text-[11px] text-gray-600 leading-relaxed">
    {#if $logs.length === 0}
      <div class="text-gray-400">Logs will appear here...</div>
    {:else}
      {#each $logs as entry (entry.id)}
        <div class="py-0.5 border-b border-gray-100 last:border-b-0">
          <span class="text-gray-400 mr-2">{formatTime(entry.timestamp)}</span>
          {entry.message}
        </div>
      {/each}
    {/if}
  </div>
</div>

