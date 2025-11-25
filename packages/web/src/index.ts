import "dotenv/config";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { agent } from "@voice-sandwich-demo/graphs";
import { readFileSync } from "fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { join } from "path";

import {
  AssemblyAISTTTransform,
  AgentTransform,
  AIMessageChunkTransform,
  HumeTTSTransform,
  LangChainAudioReadableStream,
  PipelineVisualizer,
  // ElevenLabsTTSTransform,
  // SentenceChunkTransform,
} from "./transforms";

const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/*", cors());

// Shared pipeline visualizer for WebSocket streaming
const pipelineVisualizer = new PipelineVisualizer();

// Serve static HTML
const htmlPath = join(process.cwd(), "src/static/index.html");
const html = readFileSync(htmlPath, "utf-8");

// Serve pipeline visualizer JS
const visualizerJsPath = join(process.cwd(), "src/static/pipeline-visualizer.js");
const visualizerJs = readFileSync(visualizerJsPath, "utf-8");

app.get("/", (c) => c.html(html));

app.get("/pipeline-visualizer.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(visualizerJs);
});

// Pipeline visualizer WebSocket endpoint
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

app.get(
  "/ws",
  upgradeWebSocket(() => {
    let controller: ReadableStreamDefaultController<Buffer>;
    const inputStream = new ReadableStream<Buffer>({
      start(c) {
        controller = c;
      },
    });

    const observableStream = new LangChainAudioReadableStream(inputStream, {
      visualizer: pipelineVisualizer, // Stream metrics to frontend
      turnIdleThresholdMs: 1000, // New "turn" after 1s of inactivity per stage
    });

    const pipeline = observableStream
      .pipeThrough(
        new AssemblyAISTTTransform({
          apiKey: process.env.ASSEMBLYAI_API_KEY!,
          sampleRate: 16000,
        })
      )
      .pipeThrough(new AgentTransform(agent))
      .pipeThrough(new AIMessageChunkTransform())
      .pipeThrough(new HumeTTSTransform({
        apiKey: process.env.HUME_API_KEY!,
        voiceName: process.env.HUME_VOICE_NAME!,
      }))
      // .pipeThrough(new SentenceChunkTransform()) // Stream sentences to TTS as they're generated
      // .pipeThrough(
      //   new ElevenLabsTTSTransform({
      //     apiKey: process.env.ELEVENLABS_API_KEY!,
      //     voiceId: process.env.ELEVENLABS_VOICE_ID!,
      //   })
      // );

    const reader = pipeline.getReader();
    let pipelineClosed = false;

    return {
      onOpen(_evt, ws) {
        console.log("Client connected");

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || pipelineClosed) break;
              // WSContext.readyState: 1 = OPEN
              if (ws.readyState === 1) {
                ws.send(value as any);
              }
            }
          } catch (e) {
            console.error("Pipeline error:", e);
            if (ws.readyState === 1) {
              ws.close(1011, "Internal Server Error");
            }
          }
        })();
      },
      onMessage(evt) {
        const data = evt.data;
        if (Buffer.isBuffer(data)) {
          controller.enqueue(data);
        } else if (data instanceof ArrayBuffer) {
          controller.enqueue(Buffer.from(data));
        } else {
          console.log("Received unknown data type:", typeof data);
        }
      },
      onClose() {
        console.log("Client disconnected");
        pipelineClosed = true;
        try {
          controller.close();
        } catch {
          // Ignore if already closed
        }
      },
    };
  })
);

const port = 3000;
const server = serve({
  fetch: app.fetch,
  port,
});

injectWebSocket(server);

console.log(`Server running on http://localhost:${port}`);
