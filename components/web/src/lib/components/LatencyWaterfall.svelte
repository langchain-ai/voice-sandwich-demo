<script lang="ts">
  import { currentTurn, waterfallData, computedStats, latencyStats } from '../stores';
  import { formatDuration } from '../utils';

  // Use current turn if active, otherwise preserved waterfall data
  let data = $derived($currentTurn.active ? $currentTurn : $waterfallData);

  interface BarStyle {
    left: string;
    width: string;
    opacity: number;
  }

  function getBarStyle(
    baseTime: number,
    totalDuration: number,
    startTs: number | null,
    endTs: number | null,
    isActiveNow: boolean
  ): BarStyle {
    if (!startTs) return { left: '0%', width: '0%', opacity: 0 };

    const now = Date.now();
    const left = ((startTs - baseTime) / totalDuration) * 100;

    let end: number;
    if (endTs) {
      end = endTs;
    } else if (isActiveNow) {
      end = now;
    } else {
      end = startTs;
    }

    const width = Math.max(((end - startTs) / totalDuration) * 100, 0.5);
    return { left: `${left}%`, width: `${width}%`, opacity: 1 };
  }

  function getDuration(startTs: number | null, endTs: number | null, isActiveNow: boolean): string {
    if (!startTs) return '—';
    if (!endTs && isActiveNow) return formatDuration(Date.now() - startTs);
    if (!endTs) return '—';
    return formatDuration(endTs - startTs);
  }

  let bars = $derived.by(() => {
    if (!data?.turnStartTs) return null;

    const baseTime = data.turnStartTs;
    const now = Date.now();
    const isActive = $currentTurn.active;

    // Calculate end time for scaling
    let endTime = baseTime;
    if (data.ttsEndTs) endTime = Math.max(endTime, data.ttsEndTs);
    else if (data.agentEndTs) endTime = Math.max(endTime, data.agentEndTs);
    else if (data.sttEndTs) endTime = Math.max(endTime, data.sttEndTs);
    if (isActive) endTime = Math.max(endTime, now);

    const totalDuration = Math.max(endTime - baseTime, 500);

    return {
      stt: {
        style: getBarStyle(baseTime, totalDuration, data.sttStartTs, data.sttEndTs, isActive && !!data.sttStartTs && !data.sttEndTs),
        duration: getDuration(data.sttStartTs, data.sttEndTs, isActive && !!data.sttStartTs && !data.sttEndTs),
      },
      agent: {
        style: getBarStyle(baseTime, totalDuration, data.agentStartTs, data.agentEndTs, isActive && !!data.agentStartTs && !data.agentEndTs),
        duration: getDuration(data.agentStartTs, data.agentEndTs, isActive && !!data.agentStartTs && !data.agentEndTs),
      },
      tts: {
        style: getBarStyle(baseTime, totalDuration, data.ttsStartTs, data.ttsEndTs, isActive && !!data.ttsStartTs && !data.ttsEndTs),
        duration: getDuration(data.ttsStartTs, data.ttsEndTs, isActive && !!data.ttsStartTs && !data.ttsEndTs),
      },
    };
  });

  let totalLatencyDisplay = $derived.by(() => {
    if (!data) return '—';
    if (data.sttStartTs && data.ttsEndTs) {
      return formatDuration(data.ttsEndTs - data.sttStartTs);
    }
    if ($currentTurn.active && data.sttStartTs) {
      return formatDuration(Date.now() - data.sttStartTs);
    }
    return '—';
  });
</script>

<div class="mt-5 pt-5 border-t border-gray-700">
  <!-- Header -->
  <div class="flex items-center gap-2 mb-4">
    <span class="text-xs">⏱</span>
    <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Latency Waterfall</span>
    <span class="ml-auto font-mono text-sm font-semibold text-cyan-400">{totalLatencyDisplay}</span>
  </div>

  <!-- Waterfall Bars -->
  <div class="mb-4">
    {#if bars}
      {#each [
        { label: 'STT', bar: bars.stt, gradient: 'from-cyan-400 to-emerald-500' },
        { label: 'Agent', bar: bars.agent, gradient: 'from-purple-500 to-violet-600' },
        { label: 'TTS', bar: bars.tts, gradient: 'from-orange-500 to-orange-600' },
      ] as row}
        <div class="flex items-center mb-2">
          <div class="w-12 flex-shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            {row.label}
          </div>
          <div class="flex-1 h-5 bg-[#252530] rounded relative overflow-hidden">
            <div
              class="absolute h-full rounded bg-gradient-to-r {row.gradient} min-w-0.5"
              style="left: {row.bar.style.left}; width: {row.bar.style.width}; opacity: {row.bar.style.opacity}"
            ></div>
          </div>
          <div class="w-14 flex-shrink-0 text-right font-mono text-[10px] text-gray-600 pl-2.5">
            {row.bar.duration}
          </div>
        </div>
      {/each}
    {:else}
      <div class="text-center py-4 text-gray-600 text-xs">Latency data will appear here</div>
    {/if}
  </div>

  <!-- Stats Row -->
  <div class="flex justify-between gap-2 pt-3 border-t border-gray-700">
    <div class="flex flex-col items-center gap-1">
      <span class="text-[9px] font-semibold uppercase tracking-wider text-gray-600">Turns</span>
      <span class="font-mono text-sm text-gray-500">{$latencyStats.turns}</span>
    </div>
    <div class="flex flex-col items-center gap-1">
      <span class="text-[9px] font-semibold uppercase tracking-wider text-gray-600">Avg Total</span>
      <span class="font-mono text-sm text-gray-500">{$computedStats.avg ? formatDuration($computedStats.avg) : '—'}</span>
    </div>
    <div class="flex flex-col items-center gap-1">
      <span class="text-[9px] font-semibold uppercase tracking-wider text-gray-600">Min</span>
      <span class="font-mono text-sm text-gray-500">{$computedStats.min ? formatDuration($computedStats.min) : '—'}</span>
    </div>
    <div class="flex flex-col items-center gap-1">
      <span class="text-[9px] font-semibold uppercase tracking-wider text-gray-600">Max</span>
      <span class="font-mono text-sm text-gray-500">{$computedStats.max ? formatDuration($computedStats.max) : '—'}</span>
    </div>
  </div>
</div>

