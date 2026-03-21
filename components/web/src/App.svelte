<script lang="ts">
  import { Header, Controls, PipelineCard, ActivityFeed, Console, DetailedCanvas } from './lib/components';
  import { createVoiceSession } from './lib/websocket';

  const voiceSession = createVoiceSession();
</script>

<div class="max-w-7xl mx-auto">
  <Header />
  <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
    <div class="lg:col-span-3">
      <Controls onStart={() => voiceSession.start()} onStop={() => voiceSession.stop()} />
      <PipelineCard compact={true} />
    </div>
    <div class="lg:col-span-6">
      <DetailedCanvas />
      <div class="mt-5">
        <PipelineCard />
      </div>
      <Console />
    </div>
    <div class="lg:col-span-3">
      <ActivityFeed />
    </div>
  </div>
</div>

