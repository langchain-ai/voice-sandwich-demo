import WebSocket from "ws";

interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
}

export class ElevenLabsTTSTransform extends TransformStream<string, Buffer> {
  constructor(options: ElevenLabsOptions) {
    let ws: WebSocket | null = null;
    let connectionPromise: Promise<void> | null = null;
    let activeController: TransformStreamDefaultController<Buffer> | null =
      null;

    const resetConnection = () => {
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          console.error("ElevenLabs: Error closing WebSocket:", e);
        }
        ws = null;
      }
      connectionPromise = null;
    };

    const ensureConnection = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        return Promise.resolve();
      }
      if (connectionPromise) return connectionPromise;

      connectionPromise = new Promise((resolve, reject) => {
        const modelId = options.modelId || "eleven_monolingual_v1";
        const url = `wss://api.elevenlabs.io/v1/text-to-speech/${options.voiceId}/stream-input?model_id=${modelId}&output_format=pcm_16000`;

        console.log(`ElevenLabs: Connecting to ${url}`);
        ws = new WebSocket(url);

        ws.on("open", () => {
          console.log("ElevenLabs: WebSocket connected");
          const bosMessage = {
            text: " ",
            voice_settings: {
              stability: options.stability || 0.5,
              similarity_boost: options.similarityBoost || 0.75,
            },
            xi_api_key: options.apiKey,
          };
          ws?.send(JSON.stringify(bosMessage));
          resolve();
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msgStr = data.toString();
            const response = JSON.parse(msgStr);

            if (response.audio) {
              const chunk = Buffer.from(response.audio, "base64");
              if (activeController) {
                activeController.enqueue(chunk);
              }
            }
            if (response.isFinal) {
              console.log("ElevenLabs: Received isFinal signal");
            }
            if (response.error) {
              console.error(
                "ElevenLabs: Server returned error:",
                response.error
              );
            }
          } catch (e) {
            console.error("ElevenLabs: Error parsing message:", e);
          }
        });

        ws.on("error", (err) => {
          console.error("ElevenLabs WS Error:", err);
          resetConnection();
          reject(err);
        });

        ws.on("close", (code, reason) => {
          console.log(
            `ElevenLabs: WebSocket closed (code: ${code}, reason: ${reason})`
          );
          resetConnection();
        });
      });
      return connectionPromise;
    };

    super({
      start(controller) {
        activeController = controller;
      },
      async transform(token) {
        try {
          await ensureConnection();
          if (ws && ws.readyState === WebSocket.OPEN) {
            // try_trigger_generation: true forces low latency
            const payload = { text: token, try_trigger_generation: true };
            ws.send(JSON.stringify(payload));
          } else {
            console.warn(
              "ElevenLabs: WebSocket not open, dropping token:",
              token
            );
          }
        } catch (err) {
          console.error("ElevenLabs: Error in transform:", err);
          // Don't error the controller, just log, so we can retry next chunk?
          // If we error the controller, the whole pipeline dies.
        }
      },
      async flush() {
        console.log("ElevenLabs: Flushing stream...");
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ text: "" }));
          // Wait for a bit
          await new Promise((r) => setTimeout(r, 1000));
          resetConnection();
        }
      },
    });
  }
}
