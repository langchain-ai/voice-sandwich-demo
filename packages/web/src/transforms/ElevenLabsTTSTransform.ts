import WebSocket from "ws";

interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  /**
   * Time in ms to wait after the last text token before sending EOS to flush audio.
   * This allows detecting end-of-response in a streaming context.
   * Default: 500ms
   */
  flushDelayMs?: number;
  /**
   * Callback called when TTS output is interrupted (for barge-in)
   */
  onInterrupt?: () => void;
  /**
   * Callback called when audio generation is complete (isFinal received from ElevenLabs).
   * Useful for knowing when all audio has been sent for a turn.
   */
  onAudioComplete?: () => void;
}

export class ElevenLabsTTSTransform extends TransformStream<string, Buffer> {
  private _interrupt: () => void = () => {};
  
  /**
   * Interrupt the current TTS output (for barge-in support).
   * Stops audio generation and clears any pending tokens.
   */
  interrupt(): void {
    this._interrupt();
  }

  constructor(options: ElevenLabsOptions) {
    let ws: WebSocket | null = null;
    let connectionPromise: Promise<void> | null = null;
    let activeController: TransformStreamDefaultController<Buffer> | null =
      null;
    let isShuttingDown = false;

    // Promise that resolves when isFinal is received (for flush)
    let finalResolve: (() => void) | null = null;
    let finalPromise: Promise<void> | null = null;

    // Timer for auto-flushing after a gap in text
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDelayMs = options.flushDelayMs ?? 500;

    // Track flush state to prevent concurrent flushes and race conditions
    let isFlushing = false;
    let flushCompletePromise: Promise<void> | null = null;

    // Track whether we've sent EOS - only honor isFinal after EOS is sent
    let eosSent = false;

    // Track whether we've sent any real text (not just BOS)
    let hasSentText = false;

    // Queue for tokens that arrive during flush - they'll be processed after flush completes
    const tokenQueue: string[] = [];
    
    // Mutex to serialize token processing
    let processingPromise: Promise<void> | null = null;

    // Track audio chunks for diagnostics
    let audioChunkCount = 0;
    let totalAudioBytes = 0;
    let tokensSent = 0;
    
    // Track if we're currently interrupted (for barge-in)
    let isInterrupted = false;
    
    // Track if the stream has been terminated
    let isStreamTerminated = false;

    const resetFinalPromise = () => {
      finalPromise = new Promise((resolve) => {
        finalResolve = resolve;
      });
    };

    const getWebSocketUrl = () => {
      const modelId = options.modelId || "eleven_flash_v2_5";
      return `wss://api.elevenlabs.io/v1/text-to-speech/${options.voiceId}/stream-input?model_id=${modelId}&output_format=pcm_16000`;
    };

    const closeConnection = () => {
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close errors
        }
        ws = null;
      }
      connectionPromise = null;
      // Reset state for next connection
      eosSent = false;
      hasSentText = false;
    };

    /**
     * Interrupt TTS output for barge-in
     */
    const interruptTTS = () => {
      if (isInterrupted) return;
      
      console.log("ElevenLabs: Interrupted by user (barge-in)");
      isInterrupted = true;
      
      // Cancel any pending flush timer
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      
      // Clear token queue
      tokenQueue.length = 0;
      
      // Close connection immediately (don't wait for isFinal)
      closeConnection();
      
      // Resolve any pending flush
      if (finalResolve) {
        finalResolve();
        finalResolve = null;
      }
      
      // If flushing, signal it's done
      isFlushing = false;
      
      // Call the onInterrupt callback
      options.onInterrupt?.();
      
      // Reset interrupted state after a brief delay to allow new input
      setTimeout(() => {
        isInterrupted = false;
      }, 100);
    };

    /**
     * Send EOS to flush ElevenLabs buffer and wait for remaining audio
     */
    const flushCurrentResponse = async () => {
      // Prevent concurrent flushes
      if (isFlushing) {
        return;
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      // Only flush if we've actually sent text
      if (!hasSentText) {
        console.log("ElevenLabs: No text sent, skipping flush");
        closeConnection();
        return;
      }

      isFlushing = true;
      let resolveFlushComplete: () => void;
      flushCompletePromise = new Promise((resolve) => {
        resolveFlushComplete = resolve;
      });

      try {
        // Reset the final promise right before we send EOS
        // This ensures we wait for the isFinal that corresponds to THIS EOS
        resetFinalPromise();
        
        console.log(`ElevenLabs: Sending EOS to flush audio buffer (${tokensSent} tokens sent)`);
        eosSent = true;
        ws.send(JSON.stringify({ text: "" }));

        // Wait for isFinal with a timeout
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            console.log("ElevenLabs: Flush timeout reached");
            resolve();
          }, 3000);
        });

        await Promise.race([finalPromise, timeoutPromise]);

        // Close the connection after flushing - a new one will be created for the next response
        closeConnection();
      } finally {
        isFlushing = false;
        resolveFlushComplete!();
        flushCompletePromise = null;
        
        // Process any queued tokens after flush completes
        if (tokenQueue.length > 0 && !isShuttingDown) {
          const queuedTokens = tokenQueue.splice(0, tokenQueue.length);
          console.log(`ElevenLabs: Processing ${queuedTokens.length} queued tokens`);
          for (const token of queuedTokens) {
            await processToken(token);
          }
        }
      }
    };

    const scheduleFlush = () => {
      // Clear any existing timer
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      
      // Schedule a flush after the delay
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        if (!isShuttingDown && !isFlushing) {
          await flushCurrentResponse();
        }
      }, flushDelayMs);
    };

    const cancelScheduledFlush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    };

    const createConnection = (): Promise<void> => {
      // Reset state for new connection
      eosSent = false;
      hasSentText = false;
      audioChunkCount = 0;
      totalAudioBytes = 0;
      tokensSent = 0;
      resetFinalPromise();

      return new Promise((resolve, reject) => {
        const url = getWebSocketUrl();
        console.log(`ElevenLabs: Connecting...`);
        const newWs = new WebSocket(url);

        newWs.on("open", () => {
          console.log("ElevenLabs: WebSocket connected");
          // BOS (Beginning of Stream) message - empty text to initialize
          const bosMessage = {
            text: " ",
            voice_settings: {
              stability: options.stability || 0.5,
              similarity_boost: options.similarityBoost || 0.75,
            },
            xi_api_key: options.apiKey,
          };
          newWs.send(JSON.stringify(bosMessage));
          ws = newWs;
          resolve();
        });

        newWs.on("message", (data: Buffer) => {
          // Don't process messages if stream is terminated
          if (isStreamTerminated) return;
          
          try {
            const msgStr = data.toString();
            const response = JSON.parse(msgStr);

            if (response.audio) {
              const chunk = Buffer.from(response.audio, "base64");
              audioChunkCount++;
              totalAudioBytes += chunk.length;
              
              if (activeController && !isStreamTerminated) {
                try {
                  activeController.enqueue(chunk);
                } catch {
                  // Controller might be closed, mark stream as terminated
                  console.warn("ElevenLabs: Controller closed, stopping audio output");
                  isStreamTerminated = true;
                }
              }
            }
            if (response.isFinal) {
              // Only honor isFinal if we've actually sent EOS
              // This prevents spurious isFinal from BOS causing issues
              if (eosSent) {
                console.log(`ElevenLabs: Received isFinal (${audioChunkCount} chunks, ${totalAudioBytes} bytes)`);
                // Small delay to catch any trailing audio that might arrive after isFinal
                setTimeout(() => {
                  if (finalResolve) {
                    finalResolve();
                    finalResolve = null;
                  }
                  // Notify that audio generation is complete
                  options.onAudioComplete?.();
                }, 100);
              } else {
                console.log("ElevenLabs: Ignoring isFinal (no EOS sent yet)");
              }
            }
            if (response.error) {
              console.error(
                "ElevenLabs: Server returned error:",
                response.error
              );
            }
          } catch (e) {
            // Don't log if stream is terminated - expected behavior
            if (!isStreamTerminated) {
              console.error("ElevenLabs: Error parsing message:", e);
            }
          }
        });

        newWs.on("error", (err) => {
          console.error("ElevenLabs WS Error:", err);
          if (ws === newWs) {
            ws = null;
            connectionPromise = null;
          }
          reject(err);
        });

        newWs.on("close", (code, reason) => {
          console.log(
            `ElevenLabs: WebSocket closed (code: ${code}, reason: ${reason})`
          );
          if (ws === newWs) {
            ws = null;
            connectionPromise = null;
          }
          // Resolve any pending final promise on close
          if (finalResolve) {
            finalResolve();
            finalResolve = null;
          }
        });
      });
    };

    const ensureConnection = async (): Promise<void> => {
      // Check if current connection is usable
      if (ws && ws.readyState === WebSocket.OPEN) {
        return;
      }
      // Wait for pending connection
      if (connectionPromise) {
        await connectionPromise;
        if (ws && ws.readyState === WebSocket.OPEN) {
          return;
        }
      }
      // Create new connection
      connectionPromise = createConnection();
      await connectionPromise;
    };

    /**
     * Process a single token - sends it to ElevenLabs
     */
    const processToken = async (token: string): Promise<void> => {
      if (isShuttingDown) return;
      
      // Skip empty tokens
      if (!token || token.length === 0) {
        return;
      }

      // Cancel any pending flush since we're receiving more text
      cancelScheduledFlush();

      try {
        await ensureConnection();
        if (ws && ws.readyState === WebSocket.OPEN) {
          hasSentText = true;
          tokensSent++;
          const payload = { text: token, try_trigger_generation: true };
          ws.send(JSON.stringify(payload));
          
          // Log periodically to avoid spam
          if (tokensSent === 1) {
            console.log(`ElevenLabs: Sending first token: "${token.substring(0, 20)}..."`);
          }
          
          // Schedule a flush after the delay (will be cancelled if more text arrives)
          scheduleFlush();
        } else {
          console.warn(
            "ElevenLabs: WebSocket not open, dropping token:",
            token
          );
        }
      } catch (err) {
        console.error("ElevenLabs: Error in transform:", err);
      }
    };

    /**
     * Enqueue a token for processing, serializing concurrent calls
     */
    const enqueueToken = async (token: string): Promise<void> => {
      // If we're flushing, queue the token for later
      if (isFlushing) {
        tokenQueue.push(token);
        return;
      }

      // Serialize processing to prevent race conditions
      if (processingPromise) {
        await processingPromise;
      }

      processingPromise = processToken(token);
      await processingPromise;
      processingPromise = null;
    };

    super({
      start(controller) {
        activeController = controller;
      },
      async transform(token) {
        await enqueueToken(token);
      },
      async flush() {
        console.log("ElevenLabs: Flushing stream...");
        isShuttingDown = true;
        isStreamTerminated = true;

        // Cancel any pending auto-flush
        cancelScheduledFlush();

        // Wait for any pending token processing
        if (processingPromise) {
          await processingPromise;
        }

        // Wait for any in-progress flush to complete
        if (isFlushing && flushCompletePromise) {
          await flushCompletePromise;
        }

        if (ws && ws.readyState === WebSocket.OPEN && hasSentText) {
          // Reset final promise for this final flush
          resetFinalPromise();
          
          // Send EOS (end of stream)
          eosSent = true;
          ws.send(JSON.stringify({ text: "" }));

          // Wait for final audio with timeout
          const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
              console.log("ElevenLabs: Flush timeout reached");
              resolve();
            }, 5000);
          });

          await Promise.race([finalPromise, timeoutPromise]);

          closeConnection();
        }
        connectionPromise = null;
      },
    });

    // Expose interrupt method (must be after super() call)
    this._interrupt = interruptTTS;
  }
}
