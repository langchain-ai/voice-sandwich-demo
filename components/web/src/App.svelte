<script lang="ts">
  import { Header, Controls, PipelineCard, ActivityFeed, Console } from './lib/components';
  import { createVoiceSession } from './lib/websocket';

  const voiceSession = createVoiceSession();
</script>

<div class="max-w-3xl mx-auto">
  <Header />
  <Controls
    onToggle={() => voiceSession.toggle()}
    onPlayLast={() => voiceSession.playLastRecording()}
  />
  <PipelineCard />
  <ActivityFeed />
  <Console />
</div>

