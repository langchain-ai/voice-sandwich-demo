<script lang="ts">
  import { Header, Controls, PipelineCard, ActivityFeed, Console } from './lib/components';
  import { createVoiceSession } from './lib/websocket';

  const voiceSession = createVoiceSession();
</script>

<div class="max-w-6xl mx-auto">
  <Header />
  <Controls onStart={() => voiceSession.start()} onStop={() => voiceSession.stop()} />
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
    <div class="lg:col-span-2">
      <PipelineCard />
      <Console />
    </div>
    <div class="lg:col-span-1">
      <ActivityFeed />
    </div>
  </div>
</div>

