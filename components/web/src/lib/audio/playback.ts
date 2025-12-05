// Sample rate of audio from ElevenLabs (pcm_24000 format)
const SAMPLE_RATE = 24000;

export interface AudioPlayback {
  push: (pcmBase64: string) => void;
  stop: () => void;
  resetScheduling: () => void;
}

export function createAudioPlayback(): AudioPlayback {
  let audioContext: AudioContext | null = null;
  let nextPlayTime = 0;
  let sourceQueue: AudioBufferSourceNode[] = [];
  let base64Queue: string[] = [];
  let isProcessing = false;

  function ensureContext(): AudioContext {
    if (!audioContext) {
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
    return audioContext;
  }

  function pcmBase64ToArrayBuffer(pcmBase64: string): {
    arrayBuffer: ArrayBuffer;
    length: number;
  } {
    const binaryData = atob(pcmBase64);
    const arrayBuffer = new ArrayBuffer(binaryData.length);
    const uint8Array = new Uint8Array(arrayBuffer);

    for (let i = 0; i < binaryData.length; i++) {
      uint8Array[i] = binaryData.charCodeAt(i);
    }

    return { arrayBuffer, length: uint8Array.length };
  }

  function createAudioBuffer(
    arrayBuffer: ArrayBuffer,
    length: number
  ): AudioBuffer {
    const ctx = ensureContext();
    const data = new DataView(arrayBuffer);
    const audioBuffer = ctx.createBuffer(1, length / 2, SAMPLE_RATE);
    const channelData = audioBuffer.getChannelData(0);

    for (let i = 0; i < length; i += 2) {
      const sample = data.getInt16(i, true);
      channelData[i / 2] = sample / 32768;
    }

    return audioBuffer;
  }

  function schedulePlaySource(source: AudioBufferSourceNode): void {
    source.start(nextPlayTime);
    source.addEventListener("ended", () => sourceEnded(source));
  }

  function sourceEnded(source: AudioBufferSourceNode): void {
    const index = sourceQueue.indexOf(source);
    if (index > -1) {
      sourceQueue.splice(index, 1);
    }
  }

  function processQueue(): void {
    if (isProcessing) return;
    isProcessing = true;

    while (base64Queue.length > 0) {
      const base64 = base64Queue.shift();
      if (!base64) break;

      const ctx = ensureContext();
      const { arrayBuffer, length } = pcmBase64ToArrayBuffer(base64);
      const audioBuffer = createAudioBuffer(arrayBuffer, length);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      sourceQueue.push(source);

      // If we've fallen behind, catch up to current time
      if (nextPlayTime < ctx.currentTime) {
        nextPlayTime = ctx.currentTime;
      }

      schedulePlaySource(source);
      nextPlayTime += audioBuffer.duration;
    }

    isProcessing = false;
  }

  function push(pcmBase64: string): void {
    base64Queue.push(pcmBase64);
    processQueue();
  }

  function stop(): void {
    base64Queue = [];

    for (const source of sourceQueue) {
      try {
        source.stop();
      } catch {
        // Ignore if already stopped
      }
    }
    sourceQueue = [];
    nextPlayTime = 0;
  }

  function resetScheduling(): void {
    nextPlayTime = 0;
  }

  return {
    push,
    stop,
    resetScheduling,
  };
}
