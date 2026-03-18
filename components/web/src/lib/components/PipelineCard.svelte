<script lang="ts">
  import { currentTurn, session } from '../stores';
  import Pipeline from './Pipeline.svelte';
  import LatencyWaterfall from './LatencyWaterfall.svelte';

  let isActive = $derived($session.connected || $currentTurn.active);
</script>

<div
  class="bg-[#1a1a20] text-gray-100 rounded-2xl p-6 mb-5 transition-opacity duration-300
         {isActive ? '' : 'opacity-50'}"
>
  <div class="flex items-center justify-between mb-4">
    <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Pipeline</span>
    <span
      class="font-mono text-[11px] py-1 px-2 rounded
             {isActive
               ? 'text-cyan-400 bg-cyan-400/15'
               : 'text-gray-600 bg-[#252530]'}"
    >
      {isActive ? 'Session Active' : 'Waiting...'}
    </span>
  </div>

  <Pipeline />
  <LatencyWaterfall />
</div>

