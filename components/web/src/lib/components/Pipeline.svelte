<script lang="ts">
  import { currentTurn } from '../stores';
  import { formatDuration } from '../utils';

  interface StageState {
    active: boolean;
    complete: boolean;
    time: string;
  }

  let stt = $derived<StageState>({
    active: !!$currentTurn.sttStartTs && !$currentTurn.sttEndTs,
    complete: !!$currentTurn.sttEndTs,
    time: $currentTurn.sttEndTs && $currentTurn.sttStartTs
      ? formatDuration($currentTurn.sttEndTs - $currentTurn.sttStartTs)
      : $currentTurn.sttStartTs ? '...' : '—',
  });

  let agent = $derived<StageState>({
    active: !!$currentTurn.agentStartTs && !$currentTurn.agentEndTs,
    complete: !!$currentTurn.agentEndTs,
    time: $currentTurn.agentEndTs && $currentTurn.agentStartTs
      ? formatDuration($currentTurn.agentEndTs - $currentTurn.agentStartTs)
      : $currentTurn.agentStartTs ? '...' : '—',
  });

  let tts = $derived<StageState>({
    active: !!$currentTurn.ttsStartTs && !$currentTurn.ttsEndTs,
    complete: !!$currentTurn.ttsEndTs,
    time: $currentTurn.ttsEndTs && $currentTurn.ttsStartTs
      ? formatDuration($currentTurn.ttsEndTs - $currentTurn.ttsStartTs)
      : $currentTurn.ttsStartTs ? '...' : '—',
  });

  function stageClasses(state: StageState, color: 'cyan' | 'purple' | 'orange'): string {
    const colorMap = {
      cyan: {
        border: 'border-cyan-400',
        active: 'bg-cyan-400/15 shadow-[0_0_16px_theme(colors.cyan.400/30)]',
      },
      purple: {
        border: 'border-purple-500',
        active: 'bg-purple-500/15 shadow-[0_0_16px_theme(colors.purple.500/30)]',
      },
      orange: {
        border: 'border-orange-500',
        active: 'bg-orange-500/15 shadow-[0_0_16px_theme(colors.orange.500/30)]',
      },
    };

    const c = colorMap[color];
    let classes = `w-13 h-13 rounded-xl flex items-center justify-center text-2xl
                   bg-[#252530] border-2 ${c.border} transition-all duration-300`;

    if (state.active) {
      classes += ` ${c.active} scale-105 animate-pulse`;
    } else if (state.complete) {
      classes += ' opacity-70';
    }

    return classes;
  }
</script>

<div class="flex items-center justify-center gap-4 py-4">
  <!-- STT Stage -->
  <div class="flex flex-col items-center gap-2.5">
    <div class={stageClasses(stt, 'cyan')}>🎤</div>
    <div class="text-[11px] font-medium uppercase tracking-wider text-gray-500">STT</div>
    <div class="font-mono text-xs text-gray-600">{stt.time}</div>
  </div>

  <div class="text-gray-600 text-lg -mt-6">→</div>

  <!-- Agent Stage -->
  <div class="flex flex-col items-center gap-2.5">
    <div class={stageClasses(agent, 'purple')}>🤖</div>
    <div class="text-[11px] font-medium uppercase tracking-wider text-gray-500">Agent</div>
    <div class="font-mono text-xs text-gray-600">{agent.time}</div>
  </div>

  <div class="text-gray-600 text-lg -mt-6">→</div>

  <!-- TTS Stage -->
  <div class="flex flex-col items-center gap-2.5">
    <div class={stageClasses(tts, 'orange')}>🔊</div>
    <div class="text-[11px] font-medium uppercase tracking-wider text-gray-500">TTS</div>
    <div class="font-mono text-xs text-gray-600">{tts.time}</div>
  </div>
</div>

