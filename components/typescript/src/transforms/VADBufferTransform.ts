import { RealTimeVAD } from "@ericedouard/vad-node-realtime";

export class VADBufferTransform extends TransformStream<Buffer, Buffer> {
  constructor() {
    let vad: RealTimeVAD | null = null;

    super({
      async start(controller) {
        vad = await RealTimeVAD.new({
          sampleRate: 16000,
          minSpeechFrames: 4, // ~0.125s
          // We can tweak negativeSpeechThreshold if needed for "noise"
          // onSpeechEnd provides the collected speech segment
          onSpeechEnd: (audioFloat32) => {
            // Convert Float32 back to Int16 Buffer
            const buffer = Buffer.alloc(audioFloat32.length * 2);
            for (let i = 0; i < audioFloat32.length; i++) {
              let s = Math.max(-1, Math.min(1, audioFloat32[i]));
              s = s < 0 ? s * 0x8000 : s * 0x7fff;
              buffer.writeInt16LE(s, i * 2);
            }
            console.log(`VAD: Speech detected (${buffer.length} bytes)`);
            controller.enqueue(buffer);
          },
        });
        vad.start();
      },
      transform(chunk) {
        if (!vad) return;

        // chunk is Int16LE PCM from OpusToPcmTransform
        // Convert to Float32 for VAD
        const float32 = new Float32Array(chunk.length / 2);
        for (let i = 0; i < float32.length; i++) {
          const int16 = chunk.readInt16LE(i * 2);
          float32[i] = int16 / 32768.0;
        }

        vad.processAudio(float32);
      },
      flush() {
        if (vad) {
          // vad.destroy();
        }
      },
    });
  }
}
