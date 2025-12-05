<script lang="ts">
  import { session, formattedTime } from '../stores';
</script>

<header class="flex items-center justify-between mb-7">
  <div class="flex items-center gap-3">
    <span class="text-3xl">🥪</span>
    <h1 class="text-2xl font-semibold tracking-tight text-gray-900">Voice Sandwich</h1>
  </div>
  <div class="flex items-center gap-2 font-mono text-sm text-gray-400">
    <span>{$formattedTime}</span>
    <span
      class="w-2 h-2 rounded-full transition-all duration-300 {$session.connected
        ? 'bg-green-500 shadow-[0_0_6px_theme(colors.green.500)]'
        : 'bg-gray-400'}"
    ></span>
  </div>
</header>

