import querystring from "querystring";

import WebSocket from "ws";

interface AssemblyAISTTOptions {
  apiKey: string;
  sampleRate?: number;
  formatTurns?: boolean;
  /**
   * Callback when speech is detected (partial transcript received).
   * Useful for implementing barge-in to interrupt TTS.
   */
  onSpeechStart?: () => void;
}

interface BeginMessage {
  type: "Begin";
  id: string;
  expires_at: number;
}

interface TurnMessage {
  type: "Turn";
  transcript: string;
  turn_is_formatted: boolean;
}

interface TerminationMessage {
  type: "Termination";
  audio_duration_seconds: number;
  session_duration_seconds: number;
}

type AssemblyAIMessage = BeginMessage | TurnMessage | TerminationMessage;

/**
 * AssemblyAI Real-Time Streaming STT Transform (v3 API)
 *
 * Input: PCM 16-bit audio buffer
 * Output: Transcribed text string (final/formatted transcripts only)
 *
 * Uses AssemblyAI's WebSocket-based real-time transcription API
 * for significantly lower latency than batch-based STT.
 */
export class AssemblyAISTTTransform extends TransformStream<Buffer, string> {
  constructor(options: AssemblyAISTTOptions) {
    const { apiKey, sampleRate = 16000, formatTurns = true, onSpeechStart } = options;

    let ws: WebSocket | null = null;
    let connectionPromise: Promise<void> | null = null;
    let activeController: TransformStreamDefaultController<string> | null =
      null;
    let sessionId: string | null = null;
    
    // Track if we've already signaled speech start for current utterance
    let speechStartSignaled = false;

    const resetConnection = () => {
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          console.error("AssemblyAI: Error closing WebSocket:", e);
        }
        ws = null;
      }
      connectionPromise = null;
      sessionId = null;
    };

    const ensureConnection = (): Promise<void> => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        return Promise.resolve();
      }
      if (connectionPromise) return connectionPromise;

      connectionPromise = new Promise((resolve, reject) => {
        const params = querystring.stringify({
          sample_rate: sampleRate,
          format_turns: formatTurns,
        });

        const url = `wss://streaming.assemblyai.com/v3/ws?${params}`;
        console.log(`AssemblyAI: Connecting to v3 streaming API...`);

        ws = new WebSocket(url, {
          headers: {
            Authorization: apiKey,
          },
        });

        ws.on("open", () => {
          console.log("AssemblyAI: WebSocket connected");
        });

        ws.on("message", (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString()) as AssemblyAIMessage;

            switch (message.type) {
              case "Begin":
                sessionId = message.id;
                console.log(
                  `AssemblyAI: Session started (${sessionId}), expires at ${new Date(message.expires_at * 1000).toISOString()}`
                );
                resolve();
                break;

              case "Turn":
                if (message.turn_is_formatted) {
                  // Final/formatted transcript - send to pipeline
                  if (message.transcript && message.transcript.trim().length > 0) {
                    console.log(`AssemblyAI [final]: "${message.transcript}"`);
                    if (activeController) {
                      activeController.enqueue(message.transcript);
                    }
                  }
                  // Reset speech start flag for next utterance
                  speechStartSignaled = false;
                } else {
                  // Partial transcript - log for debugging
                  if (message.transcript) {
                    console.log(`AssemblyAI [partial]: "${message.transcript}"`);
                    
                    // Signal speech start for barge-in (only once per utterance)
                    if (!speechStartSignaled && message.transcript.trim().length > 0) {
                      speechStartSignaled = true;
                      onSpeechStart?.();
                    }
                  }
                }
                break;

              case "Termination":
                console.log(
                  `AssemblyAI: Session terminated (audio: ${message.audio_duration_seconds}s, session: ${message.session_duration_seconds}s)`
                );
                resetConnection();
                break;

              default: {
                // Handle any errors or unknown message types
                const msg = message as any;
                if (msg.error) {
                  console.error("AssemblyAI error:", msg.error);
                }
              }
            }
          } catch (e) {
            console.error("AssemblyAI: Error parsing message:", e);
          }
        });

        ws.on("error", (err) => {
          console.error("AssemblyAI WebSocket Error:", err);
          resetConnection();
          reject(err);
        });

        ws.on("close", (code, reason) => {
          console.log(
            `AssemblyAI: WebSocket closed (code: ${code}, reason: ${reason})`
          );
          resetConnection();
        });

        // Timeout for connection
        setTimeout(() => {
          if (!sessionId) {
            reject(new Error("AssemblyAI: Connection timeout"));
            resetConnection();
          }
        }, 10000);
      });

      return connectionPromise;
    };

    super({
      start(controller) {
        activeController = controller;
      },

      async transform(chunk) {
        try {
          await ensureConnection();

          if (ws && ws.readyState === WebSocket.OPEN) {
            // v3 API: Send raw PCM audio bytes directly (not base64)
            ws.send(chunk);
          } else {
            console.warn("AssemblyAI: WebSocket not open, dropping audio chunk");
          }
        } catch (err) {
          console.error("AssemblyAI: Error in transform:", err);
        }
      },

      async flush() {
        console.log("AssemblyAI: Flushing stream...");
        if (ws && ws.readyState === WebSocket.OPEN) {
          // v3 API: Send terminate message
          ws.send(JSON.stringify({ type: "Terminate" }));

          // Wait for termination or timeout
          await new Promise<void>((resolve) => {
            const checkClosed = setInterval(() => {
              if (!ws || ws.readyState !== WebSocket.OPEN) {
                clearInterval(checkClosed);
                resolve();
              }
            }, 100);

            // Timeout after 3 seconds
            setTimeout(() => {
              clearInterval(checkClosed);
              resetConnection();
              resolve();
            }, 3000);
          });
        }
      },
    });
  }
}
