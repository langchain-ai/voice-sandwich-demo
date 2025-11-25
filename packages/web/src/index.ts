import "dotenv/config";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { agent } from "@voice-sandwich-demo/graphs";
import { readFileSync } from "fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { join } from "path";

import {
  TracedReadableStream,
  TracedTransformStream,
} from "./TracedReadableStream";
import {
  VADBufferTransform,
  OpenAISTTTransform,
  AgentTransform,
  AIMessageChunkTransform,
  ElevenLabsTTSTransform,
  OpusToPcmTransform,
} from "./transforms";

const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/*", cors());

// Serve static HTML
const htmlPath = join(process.cwd(), "src/static/index.html");
const html = readFileSync(htmlPath, "utf-8");

app.get("/", (c) => c.html(html));

app.get(
  "/ws",
  upgradeWebSocket(() => {
    let controller: ReadableStreamDefaultController<Buffer>;
    const inputStream = new ReadableStream<Buffer>({
      start(c) {
        controller = c;
      },
    });

    const tracedInputStream = new TracedReadableStream(inputStream);

    // Pipeline
    const pipeline = tracedInputStream
      .pipeThrough(new OpusToPcmTransform())
      .pipeThrough(new VADBufferTransform())
      .pipeThrough(
        new TracedTransformStream(
          new OpenAISTTTransform({
            apiKey: process.env.OPENAI_API_KEY!,
            model: "whisper-1",
          })
        )
      )
      .pipeThrough(new TracedTransformStream(new AgentTransform(agent)))
      .pipeThrough(new TracedTransformStream(new AIMessageChunkTransform()))
      // .pipeThrough(new SentenceChunkTransform())
      .pipeThrough(
        new TracedTransformStream(
          new ElevenLabsTTSTransform({
            apiKey: process.env.ELEVENLABS_API_KEY!,
            voiceId: process.env.ELEVENLABS_VOICE_ID!,
          })
        )
      );

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
