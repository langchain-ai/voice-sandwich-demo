// AudioWorklet code for PCM capture
const workletCode = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.targetSampleRate = 16000;
    this.resampleRatio = sampleRate / this.targetSampleRate;
    this.resampleIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    for (let i = 0; i < channelData.length; i++) {
      this.resampleIndex += 1;
      if (this.resampleIndex >= this.resampleRatio) {
        this.resampleIndex -= this.resampleRatio;
        let sample = channelData[i];
        sample = Math.max(-1, Math.min(1, sample));
        const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        this.buffer.push(int16);
      }
    }

    const CHUNK_SIZE = 1600;
    while (this.buffer.length >= CHUNK_SIZE) {
      const chunk = this.buffer.splice(0, CHUNK_SIZE);
      const int16Array = new Int16Array(chunk);
      this.port.postMessage(int16Array.buffer, [int16Array.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
`;

export interface AudioCapture {
  start: (
    onChunk: (chunk: ArrayBuffer) => void,
    options?: {
      rmsThreshold?: number;
      minSpeechMs?: number;
      onSpeechStateChange?: (speaking: boolean) => void;
    }
  ) => Promise<void>;
  stop: () => void;
}

export function createAudioCapture(): AudioCapture {
  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let mediaStream: MediaStream | null = null;
  let speechInterval: ReturnType<typeof setInterval> | null = null;
  let analyserNode: AnalyserNode | null = null;
  let speechStartedAt: number | null = null;
  let speakingNotified = false;

  async function start(
    onChunk: (chunk: ArrayBuffer) => void,
    options?: {
      rmsThreshold?: number;
      minSpeechMs?: number;
      onSpeechStateChange?: (speaking: boolean) => void;
    }
  ): Promise<void> {
    // Create AudioContext if needed
    if (!audioContext) {
      audioContext = new AudioContext();
      const blob = new Blob([workletCode], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
    }

    // Resume if suspended
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    // Get microphone access
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Create worklet node and connect
    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 1024;

    workletNode.port.onmessage = (event) => {
      onChunk(event.data);
    };

    source.connect(analyserNode);
    source.connect(workletNode);

    const rmsThreshold = options?.rmsThreshold ?? 0.04;
    const minSpeechMs = options?.minSpeechMs ?? 1000;
    const onSpeechStateChange = options?.onSpeechStateChange;
    const samples = new Float32Array(analyserNode.fftSize);
    speechInterval = setInterval(() => {
      if (!analyserNode) return;
      analyserNode.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / samples.length);
      const now = Date.now();
      if (rms >= rmsThreshold) {
        speechStartedAt = speechStartedAt ?? now;
        if (!speakingNotified && now - speechStartedAt >= minSpeechMs) {
          speakingNotified = true;
          onSpeechStateChange?.(true);
        }
      } else {
        speechStartedAt = null;
        if (speakingNotified) {
          speakingNotified = false;
          onSpeechStateChange?.(false);
        }
      }
    }, 100);
  }

  function stop(): void {
    if (speechInterval) {
      clearInterval(speechInterval);
      speechInterval = null;
    }
    speechStartedAt = null;
    speakingNotified = false;
    analyserNode = null;

    if (workletNode) {
      workletNode.disconnect();
      workletNode = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
  }

  return { start, stop };
}
