import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import wrtc from "@roamhq/wrtc";
import { agent } from "@voice-sandwich-demo/graphs";
import {
  AssemblyAISTTTransform,
  AgentTransform,
  AIMessageChunkTransform,
  ElevenLabsTTSTransform,
  LangChainAudioReadableStream,
  PipelineVisualizer,
} from "@voice-sandwich-demo/web";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { ThinkingFillerTransform } from "./ThinkingFillerTransform";

const { RTCPeerConnection, RTCSessionDescription } = wrtc;

const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/*", cors());

// Shared pipeline visualizer for WebSocket streaming
const pipelineVisualizer = new PipelineVisualizer();

// Serve static HTML
const htmlPath = join(process.cwd(), "src", "static", "index.html");
const html = readFileSync(htmlPath, "utf-8");

// Serve pipeline visualizer JS
const visualizerJsPath = fileURLToPath(import.meta.resolve("@voice-sandwich-demo/web/visualizer"));
const visualizerJs = readFileSync(visualizerJsPath, "utf-8");

app.get("/", (c) => c.html(html));

app.get("/pipeline-visualizer.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(visualizerJs);
});

// Pipeline visualizer WebSocket endpoint (still uses WebSocket for visualization)
app.get(
  "/ws/pipeline",
  upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      console.log("Pipeline visualizer connected");
      pipelineVisualizer.setWebSocket(ws);
    },
    onClose() {
      console.log("Pipeline visualizer disconnected");
      pipelineVisualizer.clearWebSocket();
    },
  }))
);

// WebRTC signaling endpoint - uses WebSocket for signaling only
app.get(
  "/ws/signaling",
  upgradeWebSocket(() => {
    let peerConnection: InstanceType<typeof RTCPeerConnection> | null = null;
    let audioDataChannel: wrtc.RTCDataChannel | null = null;
    let controller: ReadableStreamDefaultController<Buffer>;
    let pipelineClosed = false;
    // Store WebSocket reference for use in callbacks
    let signalingWs: { send: (data: string) => void; readyState: number } | null = null;

    // Helper to send signaling messages (defined early for use in callbacks)
    function sendSignalingMessage(message: object) {
      if (signalingWs && signalingWs.readyState === 1) {
        signalingWs.send(JSON.stringify(message));
      }
    }

    // Track if hang up has been requested (wait for audio to complete first)
    let pendingHangUp: string | null = null;

    // Helper to close the connection (used by hang_up tool)
    function closeConnection(reason: string) {
      console.log(`Closing connection: ${reason}`);
      pipelineClosed = true;

      // Notify client that call is ending
      if (audioDataChannel && audioDataChannel.readyState === "open") {
        audioDataChannel.send(JSON.stringify({ type: "call-ended", reason }));
      }

      // Give client a moment to receive the message before closing
      setTimeout(() => {
        if (audioDataChannel) {
          audioDataChannel.close();
          audioDataChannel = null;
        }

        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }

        try {
          controller.close();
        } catch {
          // Ignore if already closed
        }

        // Close the signaling WebSocket
        sendSignalingMessage({ type: "connection-closed", reason });
      }, 500);
    }

    // Create TTS transform separately so we can access interrupt()
    const ttsTransform = new ElevenLabsTTSTransform({
      apiKey: process.env.ELEVENLABS_API_KEY!,
      voiceId: process.env.ELEVENLABS_VOICE_ID!,
      onInterrupt: () => {
        // Tell client to clear audio buffer
        if (audioDataChannel && audioDataChannel.readyState === "open") {
          audioDataChannel.send(JSON.stringify({ type: "clear-audio" }));
        }
      },
      onAudioComplete: () => {
        // Check if we have a pending hang up - if so, close the connection now
        if (pendingHangUp) {
          console.log(`Audio complete, executing pending hang up: ${pendingHangUp}`);
          closeConnection(pendingHangUp);
          pendingHangUp = null;
        }
      },
    });

    // Create thinking filler transform for more natural conversations
    const fillerTransform = new ThinkingFillerTransform({
      thresholdMs: 1200, // Emit filler if agent takes longer than 1.2s
      fillerPhrases: [
        "Let me see here...",
        "Hmm, one moment...",
        "Ah, let me check...",
        "Just a second...",
        "Mhm, okay...",
        "Let me think about that...",
      ],
      maxFillersPerTurn: 1,
      onFillerEmitted: (phrase) => {
        console.log(`Thinking filler emitted: "${phrase}"`);
      },
    });

    // Create STT transform with speech detection for barge-in
    const sttTransform = new AssemblyAISTTTransform({
      apiKey: process.env.ASSEMBLYAI_API_KEY!,
      sampleRate: 16000,
      onSpeechStart: () => {
        // User started speaking - interrupt TTS and cancel pending filler
        console.log("Barge-in: User started speaking, interrupting TTS");
        ttsTransform.interrupt();
        fillerTransform.cancelPendingFiller();
      },
    });

    const inputStream = new ReadableStream<Buffer>({
      start(c) {
        controller = c;
      },
    });

    const observableStream = new LangChainAudioReadableStream(inputStream, {
      visualizer: pipelineVisualizer,
      turnIdleThresholdMs: 1000,
    });

    // Named passthrough class to avoid "AnonymousT" in visualizer
    // This notifies filler transform when agent starts processing
    class FillerNotifyPassthrough extends TransformStream<string, string> {
      constructor() {
        super({
          transform(text, controller) {
            console.log("Agent processing started, filler timer activated");
            fillerTransform.notifyProcessingStarted();
            controller.enqueue(text);
          },
        });
      }
    }
    const agentNotifyTransform = new FillerNotifyPassthrough();

    const pipeline = observableStream
      .pipeThrough(sttTransform)
      .pipeThrough(agentNotifyTransform) // Tap to notify filler transform
      .pipeThrough(
        new AgentTransform(agent, {
          onInterrupt: (value) => {
            console.log("[AgentTransform] Human-in-the-loop interrupt:", value);
            // The interrupt message will be spoken via TTS automatically
            // since it's emitted as an AIMessageChunk
          },
          onHangUp: (reason) => {
            console.log("[AgentTransform] Agent initiated hang up, waiting for audio to complete:", reason);
            // Don't close immediately - wait for TTS to finish playing the goodbye message
            pendingHangUp = reason;
          },
        })
      )
      .pipeThrough(new AIMessageChunkTransform())
      .pipeThrough(fillerTransform) // Insert filler between AI text and TTS
      .pipeThrough(ttsTransform);

    const reader = pipeline.getReader();

    // Track audio output for diagnostics
    let audioChunksSent = 0;
    let totalBytesSent = 0;

    // Track if pipeline has errored to avoid repeated error logs
    let pipelineErrored = false;

    // Start reading from pipeline and send through data channel
    async function startPipelineReader() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || pipelineClosed) break;
          
          if (audioDataChannel && audioDataChannel.readyState === "open") {
            // Send audio data through WebRTC data channel
            audioDataChannel.send(value);
            audioChunksSent++;
            totalBytesSent += value.length;
            
            // Log periodically
            if (audioChunksSent === 1) {
              console.log("Pipeline: Sending first audio chunk to client");
            }
          } else {
            console.warn(`Pipeline: Data channel not open, dropping audio chunk (state: ${audioDataChannel?.readyState})`);
          }
        }
        console.log(`Pipeline: Finished reading (${audioChunksSent} chunks, ${totalBytesSent} bytes sent)`);
      } catch (e) {
        if (!pipelineErrored) {
          pipelineErrored = true;
          console.error("Pipeline error:", e);
          // Mark pipeline as closed to stop further processing
          pipelineClosed = true;
        }
      }
    }

    return {
      onOpen(_evt, ws) {
        console.log("Signaling WebSocket connected");
        // Store the WebSocket reference
        signalingWs = ws;

        // Create peer connection with ICE servers
        peerConnection = new RTCPeerConnection({
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
          ],
        });

        // Handle ICE candidates - send to client via signaling WebSocket
        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            console.log("Sending ICE candidate to client");
            sendSignalingMessage({
              type: "ice-candidate",
              candidate: event.candidate,
            });
          }
        };

        peerConnection.onicegatheringstatechange = () => {
          console.log("ICE gathering state:", peerConnection?.iceGatheringState);
        };

        peerConnection.oniceconnectionstatechange = () => {
          console.log("ICE connection state:", peerConnection?.iceConnectionState);
        };

        peerConnection.onconnectionstatechange = () => {
          console.log("Connection state:", peerConnection?.connectionState);
          if (peerConnection?.connectionState === "connected") {
            console.log("WebRTC connection established");
          }
        };

        // Handle incoming data channel (created by client)
        peerConnection.ondatachannel = (event) => {
          const channel = event.channel;
          console.log("Data channel received:", channel.label);

          if (channel.label === "audio") {
            audioDataChannel = channel;

            channel.onopen = () => {
              console.log("Audio data channel open");
              // Start the pipeline reader when data channel opens
              startPipelineReader();
            };

            channel.onmessage = (msgEvent) => {
              // Don't enqueue if pipeline is closed or errored
              if (pipelineClosed || pipelineErrored) return;
              
              // Receive audio data from client
              const data = msgEvent.data;
              if (data instanceof ArrayBuffer) {
                try {
                  controller.enqueue(Buffer.from(data));
                } catch {
                  // Controller might be closed - mark pipeline as closed to avoid repeated errors
                  if (!pipelineClosed) {
                    console.warn("Failed to enqueue audio data, closing pipeline");
                    pipelineClosed = true;
                  }
                }
              } else if (typeof data === "string") {
                // Could be a control message
                console.log("Received string message:", data);
              }
            };

            channel.onclose = () => {
              console.log("Audio data channel closed");
            };

            channel.onerror = (err) => {
              console.error("Audio data channel error:", err);
            };
          }
        };
      },

      async onMessage(evt) {
        try {
          const message = JSON.parse(evt.data as string);

          if (message.type === "offer") {
            // Received SDP offer from client
            console.log("Received offer");
            await peerConnection!.setRemoteDescription(
              new RTCSessionDescription(message.sdp)
            );

            // Create and send answer
            const answer = await peerConnection!.createAnswer();
            await peerConnection!.setLocalDescription(answer);

            sendSignalingMessage({
              type: "answer",
              sdp: peerConnection!.localDescription,
            });
            console.log("Sent answer");
          } else if (message.type === "ice-candidate") {
            // Received ICE candidate from client
            console.log("Received ICE candidate from client");
            if (message.candidate) {
              await peerConnection!.addIceCandidate(message.candidate);
            }
          }
        } catch (e) {
          console.error("Error processing signaling message:", e);
        }
      },

      onClose() {
        console.log("Signaling WebSocket disconnected");
        pipelineClosed = true;
        signalingWs = null;
        
        // Clean up
        if (audioDataChannel) {
          audioDataChannel.close();
          audioDataChannel = null;
        }
        
        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }
        
        try {
          controller.close();
        } catch {
          // Ignore if already closed
        }
      },
    };
  })
);

const port = 3001;
const server = serve({
  fetch: app.fetch,
  port,
});

injectWebSocket(server);

console.log(`WebRTC Server running on http://localhost:${port}`);
