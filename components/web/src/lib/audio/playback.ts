// Sample rate of audio from ElevenLabs (pcm_24000 format)
const SAMPLE_RATE = 24000;

export interface AudioPlayback {
  play: (buffer: ArrayBuffer) => Promise<void>;
  stop: () => void;
  resetScheduling: () => void;
  getBufferedDuration: () => number;
}

export function createAudioPlayback(): AudioPlayback {
  let audioContext: AudioContext | null = null;
  let nextPlayTime = 0;
  let sources: AudioBufferSourceNode[] = [];

  async function ensureContext(): Promise<AudioContext> {
    if (!audioContext) {
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  }

  function convertPCM16ToFloat32(pcmData: ArrayBuffer): Float32Array {
    const int16Data = new Int16Array(pcmData);
    const float32Data = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      float32Data[i] = int16Data[i] / 32768;
    }
    return float32Data;
  }

  async function play(pcmData: ArrayBuffer): Promise<void> {
    const ctx = await ensureContext();

    const float32Data = convertPCM16ToFloat32(pcmData);
    if (float32Data.length === 0) return;

    const audioBuffer = ctx.createBuffer(1, float32Data.length, SAMPLE_RATE);
    audioBuffer.copyToChannel(float32Data as Float32Array<ArrayBuffer>, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    // Schedule this buffer to play right after the previous one
    const currentTime = ctx.currentTime;
    const startTime = Math.max(currentTime, nextPlayTime);

    source.start(startTime);
    nextPlayTime = startTime + audioBuffer.duration;

    // Track source for cleanup/stopping
    sources.push(source);
    source.onended = () => {
      const index = sources.indexOf(source);
      if (index > -1) sources.splice(index, 1);
    };
  }

  function stop(): void {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Ignore if already stopped
      }
    }
    sources = [];
    nextPlayTime = 0;
  }

  function resetScheduling(): void {
    nextPlayTime = 0;
  }

  function getBufferedDuration(): number {
    if (!audioContext) return 0;
    return Math.max(0, nextPlayTime - audioContext.currentTime);
  }

  return { play, stop, resetScheduling, getBufferedDuration };
}
