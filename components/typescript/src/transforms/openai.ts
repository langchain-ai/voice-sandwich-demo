import { OpenAI, toFile } from "openai";

interface OpenAISTTTransformOptions {
  apiKey: string;
  model: string;
}

function createWavHeader(len: number) {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + len, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28); // Byte Rate (16000 * 2)
  buffer.writeUInt16LE(2, 32); // Block align
  buffer.writeUInt16LE(16, 34); // Bits
  buffer.write("data", 36);
  buffer.writeUInt32LE(len, 40);
  return buffer;
}

export class OpenAISTTTransform extends TransformStream<Buffer, string> {
  constructor(options: OpenAISTTTransformOptions) {
    const { apiKey, model } = options;
    const openai = new OpenAI({ apiKey });

    super({
      async transform(chunk, controller) {
        try {
          // Chunk is raw PCM 16-bit 16kHz
          const header = createWavHeader(chunk.length);
          const wavData = Buffer.concat([header, chunk]);
          
          // toFile handles Buffers
          const file = await toFile(wavData, "input.wav", { type: "audio/wav" });

          const response = await openai.audio.transcriptions.create({
            file,
            model,
          });

          const text = response.text;
          if (text && text.trim().length > 0) {
            console.log(`Transcribed: "${text}"`);
            controller.enqueue(text);
          } else {
            console.log("Transcription empty, ignoring.");
          }
        } catch (err) {
          console.error("OpenAI STT Error:", err);
        }
      },
    });
  }
}

interface OpenAITTSTransformOptions {
  apiKey: string;
  model: string;
  voice: string;
}

export class OpenAITTSTransform extends TransformStream<string, Buffer> {
  constructor(options: OpenAITTSTransformOptions) {
    const { apiKey, model, voice } = options;
    const openai = new OpenAI({ apiKey });

    super({
      async transform(text, controller) {
        try {
          const mp3Response = await openai.audio.speech.create({
            model,
            voice: voice as any,
            input: text,
            response_format: "mp3",
          });

          const buffer = Buffer.from(await mp3Response.arrayBuffer());
          controller.enqueue(buffer);
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }
}