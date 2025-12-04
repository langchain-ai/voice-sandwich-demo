import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createAgent } from "langchain";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import type WebSocket from "ws";
import { iife, writableIterator } from "./utils";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { ElevenLabsTTS } from "./elevenlabs";
import { AssemblyAISTT } from "./assemblyai/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, "../static");
const PORT = parseInt(process.env.PORT || "8000");

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/*", cors());

const addToOrder = tool(
  async ({ item, quantity }) => {
    return `Added ${quantity} x ${item} to the order.`;
  },
  {
    name: "add_to_order",
    description: "Add an item to the customer's sandwich order.",
    schema: z.object({
      item: z.string(),
      quantity: z.number(),
    }),
  }
);

const confirmOrder = tool(
  async ({ orderSummary }) => {
    return `Order confirmed: ${orderSummary}. Sending to kitchen.`;
  },
  {
    name: "confirm_order",
    description: "Confirm the final order with the customer.",
    schema: z.object({
      orderSummary: z.string().describe("Summary of the order"),
    }),
  }
);

const systemPrompt = `
You are a helpful sandwich shop assistant. Your goal is to take the user's order.
Be concise and friendly. Do NOT use emojis, special characters, or markdown.
Your responses will be read by a text-to-speech engine.

Available toppings: lettuce, tomato, onion, pickles, mayo, mustard.
Available meats: turkey, ham, roast beef.
Available cheeses: swiss, cheddar, provolone.
`;

const agent = createAgent({
  model: "claude-haiku-4-5",
  tools: [addToOrder, confirmOrder],
  checkpointer: new MemorySaver(),
  systemPrompt: systemPrompt,
});

/**
 * Transform stream: Audio (Uint8Array) → Transcript (String)
 *
 * This function takes a stream of audio chunks and sends them to AssemblyAI for STT.
 *
 * It uses a producer-consumer pattern where:
 * - Producer: Reads audio chunks from audioStream and sends them to AssemblyAI
 * - Consumer: Receives transcription results from AssemblyAI and yields them
 *
 * @param audioStream - Async iterator of PCM audio bytes (16-bit, mono, 16kHz)
 * @returns Async generator yielding transcribed text strings from AssemblyAI
 */
async function* sttStream(
  audioStream: AsyncIterable<Uint8Array>
): AsyncGenerator<string> {
  const stt = new AssemblyAISTT({ sampleRate: 16000 });

  /**
   * Promise that pumps audio chunks to AssemblyAI.
   *
   * This runs concurrently with the main function that receives transcripts.
   * It establishes the WebSocket connection, streams all audio chunks,
   * and signals completion when the input stream ends.
   */
  const producer = iife(async () => {
    try {
      // Stream each audio chunk to AssemblyAI as it arrives
      for await (const audioChunk of audioStream) {
        await stt.sendAudio(audioChunk);
      }
    } finally {
      // Signal to AssemblyAI that audio streaming is complete
      await stt.close();
    }
  });

  try {
    // Consumer loop: receive and yield transcripts as they arrive from AssemblyAI
    yield* stt.receiveMessages();
  } finally {
    await producer;
  }
}

/**
 * Transform stream: Transcripts (String) → Agent Responses (String)
 *
 * This function takes a stream of transcript strings from the STT stage and
 * passes each one to the LangChain agent. The agent processes the transcript
 * and streams back its response tokens, which are yielded one by one.
 *
 * @param transcriptStream - An async iterator of transcript strings from the STT stage
 * @returns Async generator yielding string chunks of the agent's response as they are generated
 */
async function* agentStream(
  transcriptStream: AsyncIterable<string>
): AsyncGenerator<string> {
  // Generate a unique thread ID for this conversation session
  // This allows the agent to maintain conversation context across multiple turns
  // using the checkpointer (MemorySaver) configured in the agent
  const threadId = uuidv4();

  // Process each transcript as it arrives from the upstream STT stage
  for await (const transcript of transcriptStream) {
    // Stream the agent's response using LangChain's stream method
    const stream = await agent.stream(
      { messages: [new HumanMessage(transcript)] },
      {
        configurable: { thread_id: threadId },
        streamMode: "messages",
      }
    );

    // Iterate through the agent's streaming response
    // The stream yields tuples of (message, metadata), but we only need the message
    for await (const [message] of stream) {
      // Extract and yield the text content from each message chunk
      // This allows downstream stages to process the response incrementally
      yield message.text;
    }
  }
}

/**
 * Transform stream: Agent Response Text (String) → Audio (Uint8Array)
 *
 * This function takes a stream of text strings from the agent and converts them
 * to PCM audio bytes using ElevenLabs' streaming TTS API. It manages the concurrent
 * operations of sending text to ElevenLabs and receiving audio back.
 *
 * It uses a producer-consumer pattern where:
 * - Producer: Reads text chunks from responseStream and sends them to ElevenLabs
 * - Consumer: Receives audio chunks from ElevenLabs and yields them downstream
 *
 * @param responseStream - An async iterator of text strings from the agent stage
 * @returns Async generator yielding PCM audio bytes (16-bit, mono, 16kHz) as they are received from ElevenLabs
 */
async function* ttsStream(
  responseStream: AsyncIterable<string>
): AsyncGenerator<Uint8Array> {
  const tts = new ElevenLabsTTS();

  /**
   * Promise that reads text from responseStream and sends it to ElevenLabs.
   *
   * This runs concurrently with the main function, continuously reading text
   * chunks from the agent's response stream and forwarding them to ElevenLabs
   * for synthesis. This allows audio generation to begin before the agent has
   * finished generating all text.
   */
  const producer = iife(async () => {
    try {
      for await (const text of responseStream) {
        // Send each text chunk to ElevenLabs for immediate synthesis
        // ElevenLabs will begin generating audio as soon as it receives text
        await tts.sendText(text);
      }
    } finally {
      // Signal to ElevenLabs that text sending is complete
      await tts.close();
    }
  });

  try {
    // Consumer loop: Receive audio chunks from ElevenLabs and yield them
    // This runs concurrently with producer, allowing audio to be streamed
    // to the client as it's generated, rather than waiting for all text first
    yield* tts.receiveAudio();
  } finally {
    await producer;
  }
}

app.get("/*", serveStatic({ root: STATIC_DIR }));

app.get(
  "/ws",
  upgradeWebSocket(async () => {
    let currentSocket: WSContext<WebSocket> | undefined;

    // Create a writable stream for incoming WebSocket audio data
    const inputStream = writableIterator<Uint8Array>();

    // Define the voice processing pipeline as a chain of async generators
    // Audio -> Transcripts
    const transcriptStream = sttStream(inputStream);
    // Transcripts -> Agent Responses
    const agentResponseStream = agentStream(transcriptStream);
    // Agent Responses -> Audio
    const agentAudioStream = ttsStream(agentResponseStream);

    const flushPromise = iife(async () => {
      // Stream the final audio output back to the WebSocket client
      for await (const output of agentAudioStream) {
        if (currentSocket?.readyState === 1) {
          currentSocket.send(output as Uint8Array<ArrayBuffer>);
        }
      }
    });

    return {
      onOpen(_, ws) {
        currentSocket = ws;
      },
      onMessage(event) {
        // Push incoming audio data into the pipeline's input stream
        const data = event.data;
        if (Buffer.isBuffer(data)) {
          inputStream.push(new Uint8Array(data));
        } else if (data instanceof ArrayBuffer) {
          inputStream.push(new Uint8Array(data));
        }
      },
      async onClose() {
        // Signal end of stream when socket closes
        inputStream.cancel();
        await flushPromise;
      },
    };
  })
);

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

injectWebSocket(server);

console.log(`Server is running on port ${PORT}`);
