<script lang="ts">
  import { detailedStream } from '../stores';
  import { formatTime } from '../utils';
</script>

<div class="bg-white rounded-2xl p-6 border border-gray-200 h-full">
  <div class="flex items-center justify-between mb-4">
    <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Detailed Output Canvas</span>
    <button
      onclick={() => detailedStream.clear()}
      class="text-[11px] text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
    >
      Clear
    </button>
  </div>

  <div class="h-[34rem] overflow-y-auto flex flex-col gap-2.5">
    {#if $detailedStream.length === 0}
      <div class="text-gray-400 text-sm py-5 text-center">No detailed output yet...</div>
    {:else}
      {#each $detailedStream as item (item.id)}
        <div class="p-3 rounded-xl bg-gray-100 border border-gray-200">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-blue-600 mb-1">
            Task {item.taskId ?? "-"}
          </div>
          <div class="text-sm text-gray-900 whitespace-pre-wrap leading-relaxed">{item.text}</div>
          <div class="mt-1 text-[10px] text-gray-400 font-mono">{formatTime(new Date(item.ts))}</div>
        </div>
      {/each}
    {/if}
  </div>
</div>

