<script lang="ts">
  import { activities } from '../stores';
  import { formatTime } from '../utils';

  const iconMap: Record<string, string> = {
    stt: '🎤',
    agent: '🤖',
    tts: '🔊',
    tool: '🔧',
  };

  const colorMap: Record<string, { bg: string; label: string }> = {
    stt: { bg: 'bg-cyan-400/10', label: 'text-cyan-400' },
    agent: { bg: 'bg-purple-500/10', label: 'text-purple-500' },
    tts: { bg: 'bg-orange-500/10', label: 'text-orange-500' },
    tool: { bg: 'bg-blue-500/10', label: 'text-blue-500' },
  };
</script>

<div class="bg-white rounded-2xl p-6 mb-5 border border-gray-200">
  <div class="flex items-center justify-between mb-4">
    <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Activity</span>
    <button
      onclick={() => activities.clear()}
      class="text-[11px] text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
    >
      Clear
    </button>
  </div>

  <div class="max-h-80 overflow-y-auto flex flex-col gap-2.5">
    {#if $activities.length === 0}
      <div class="text-gray-400 text-sm py-5 text-center">No activity yet...</div>
    {:else}
      {#each $activities as item (item.id)}
        <div class="flex items-start gap-3 p-3 bg-gray-100 rounded-xl animate-slideIn">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center text-sm flex-shrink-0 {colorMap[item.type]?.bg}">
            {iconMap[item.type] || '📋'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-[10px] font-semibold uppercase tracking-wider mb-0.5 {colorMap[item.type]?.label}">
              {item.label}
            </div>
            <div class="text-sm text-gray-900 leading-relaxed break-words">{item.text}</div>
            {#if item.args}
              <pre class="mt-2 p-2 bg-black/5 rounded-md font-mono text-[11px] text-gray-600 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(item.args, null, 2)}</pre>
            {/if}
            <div class="mt-1">
              <span class="font-mono text-[10px] text-gray-400">{formatTime(item.timestamp)}</span>
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .animate-slideIn {
    animation: slideIn 0.3s ease-out;
  }
</style>

