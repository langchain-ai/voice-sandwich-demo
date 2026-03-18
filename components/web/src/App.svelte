<script lang="ts">
  import { Header, Controls, PipelineCard, ActivityFeed, Console } from './lib/components';
  import { createVoiceSession } from './lib/websocket';

  const voiceSession = createVoiceSession();
</script>

<div class="max-w-3xl mx-auto">
  <Header />
  <Controls onStart={() => voiceSession.start()} onStop={() => voiceSession.stop()} />
  <PipelineCard />
  <ActivityFeed />
  <Console />
</div>

