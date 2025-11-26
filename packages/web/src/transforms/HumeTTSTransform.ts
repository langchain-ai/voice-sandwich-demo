import WebSocket from "ws";

interface HumeTTSOptions {
  apiKey: string;
  voiceName?: string;
  voiceProvider?: "HUME_AI" | "CUSTOM_VOICE";
  outputSampleRate?: number; // Target sample rate for output (default 16000)
}

/**
 * Resample PCM audio from source rate to target rate
 * Simple linear interpolation resampling
 */
function resamplePCM(
  input: Buffer,
  sourceSampleRate: number,
  targetSampleRate: number
): Buffer {
  if (sourceSampleRate === targetSampleRate) {
    return input;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const inputSamples = input.length / 2; // 16-bit = 2 bytes per sample
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, inputSamples - 1);
    const fraction = srcIndex - srcIndexFloor;

    // Linear interpolation between samples
    const sample1 = input.readInt16LE(srcIndexFloor * 2);
    const sample2 = input.readInt16LE(srcIndexCeil * 2);
    const interpolated = Math.round(sample1 + (sample2 - sample1) * fraction);

    output.writeInt16LE(
      Math.max(-32768, Math.min(32767, interpolated)),
      i * 2
    );
  }

  return output;
}

/**
 * Hume AI Text-to-Speech Transform
 *
 * Input: Text string (sentences)
 * Output: PCM audio buffer (resampled to target rate, 16-bit, mono)
 *
 * Uses Hume's WebSocket streaming API with instant_mode for low latency.
 * Hume outputs at 48kHz, so we resample to 16kHz for compatibility.
 */
export class HumeTTSTransform extends TransformStream<string, Buffer> {
  constructor(options: HumeTTSOptions) {
    const {
      apiKey,
      voiceName = "Ava Song",
      voiceProvider = "HUME_AI",
      outputSampleRate = 16000,
    } = options;

    // Hume's default output sample rate
    const HUME_SAMPLE_RATE = 48000;

    let ws: WebSocket | null = null;
    let connectionPromise: Promise<void> | null = null;
    let activeController: TransformStreamDefaultController<Buffer> | null =
      null;
    let isShuttingDown = false;

    // Promise that resolves when stream is closed
    let closeResolve: (() => void) | null = null;
    let closePromise: Promise<void> | null = null;

    const resetClosePromise = () => {
      closePromise = new Promise((resolve) => {
        closeResolve = resolve;
      });
    };

    const createConnection = (): Promise<void> => {
      resetClosePromise();

      return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
          api_key: apiKey,
          no_binary: "true", // Receive base64 text instead of binary
          instant_mode: "true", // Low latency streaming
          strip_headers: "true", // No WAV headers
          format_type: "pcm", // Raw PCM output
        });

        const url = `wss://api.hume.ai/v0/tts/stream/input?${params.toString()}`;
        console.log("Hume TTS: Connecting...");

        const newWs = new WebSocket(url);

        newWs.on("open", () => {
          console.log("Hume TTS: WebSocket connected");
          ws = newWs;
          resolve();
        });

        newWs.on("message", (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());

            if (message.type === "audio" && message.audio) {
              // Decode base64 audio
              let audioBuffer = Buffer.from(message.audio, "base64");

              // Resample from Hume's 48kHz to target rate (16kHz)
              if (HUME_SAMPLE_RATE !== outputSampleRate) {
                // @ts-ignore
                audioBuffer = resamplePCM(
                  audioBuffer,
                  HUME_SAMPLE_RATE,
                  outputSampleRate
                );
              }

              if (activeController) {
                activeController.enqueue(audioBuffer);
              }
            } else if (message.type === "error") {
              console.error("Hume TTS error:", message.message || message);
            }
          } catch (e) {
            console.error("Hume TTS: Error parsing message:", e);
          }
        });

        newWs.on("error", (err) => {
          console.error("Hume TTS WebSocket Error:", err);
          if (ws === newWs) {
            ws = null;
            connectionPromise = null;
          }
          reject(err);
        });

        newWs.on("close", (code, reason) => {
          console.log(
            `Hume TTS: WebSocket closed (code: ${code}, reason: ${reason})`
          );
          if (ws === newWs) {
            ws = null;
            connectionPromise = null;
          }
          if (closeResolve) {
            closeResolve();
            closeResolve = null;
          }
        });
      });
    };

    const ensureConnection = async (): Promise<void> => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        return;
      }
      if (connectionPromise) {
        await connectionPromise;
        if (ws && ws.readyState === WebSocket.OPEN) {
          return;
        }
      }
      connectionPromise = createConnection();
      await connectionPromise;
    };

    super({
      start(controller) {
        activeController = controller;
      },

      async transform(text) {
        if (isShuttingDown) return;

        try {
          await ensureConnection();

          if (ws && ws.readyState === WebSocket.OPEN) {
            // Send text with voice configuration
            const message = {
              text,
              voice: {
                name: voiceName,
                provider: voiceProvider,
              },
            };
            ws.send(JSON.stringify(message));

            // Flush to trigger immediate generation
            ws.send(JSON.stringify({ flush: true }));
          } else {
            console.warn("Hume TTS: WebSocket not open, dropping text:", text);
          }
        } catch (err) {
          console.error("Hume TTS: Error in transform:", err);
        }
      },

      async flush() {
        console.log("Hume TTS: Flushing stream...");
        isShuttingDown = true;

        if (ws && ws.readyState === WebSocket.OPEN) {
          // Send close signal to finish processing
          ws.send(JSON.stringify({ close: true }));

          // Wait for server to close connection with timeout
          const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
              console.log("Hume TTS: Flush timeout reached");
              resolve();
            }, 5000);
          });

          await Promise.race([closePromise, timeoutPromise]);

          // Ensure connection is closed
          try {
            ws.close();
          } catch {
            // Ignore close errors
          }
          ws = null;
        }
        connectionPromise = null;
      },
    });
  }
}
