import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MemorySaver } from "@langchain/langgraph";
import { AssemblyAISpeechToText } from "@voice-sandwich-demo/assemblyai";
import { createVoiceAgent } from "@voice-sandwich-demo/core";
import { ElevenLabsTextToSpeech } from "@voice-sandwich-demo/elevenlabs";

import { fillerMiddleware } from "./middleware.js";
import { addToOrder, confirmOrder, hangUp } from "./tools.js";

const SYSTEM_PROMPT = `
You are a helpful sandwich shop assistant. Your goal is to take the user's order. 
Be concise and friendly. 

Available options:
- Meats: turkey, ham, roast beef
- Cheeses: swiss, cheddar, provolone
- Toppings: lettuce, tomato, onion, pickles, mayo, mustard

IMPORTANT: Call the hang_up tool when:
- After confirming an order and the customer is done
- When the customer says goodbye or thanks you
- When the customer says "that's it", "that's all", "bye", etc.
`;

let pendingHangUp: string | null = null;

interface CreateVoiceAgentParams {
  closeConnection?: (reason: string) => void;
  /** Additional callback to run when speech starts (for barge-in handling). */
  onSpeechStart?: () => void;
}

export function createSandwichShopVoiceAgent(params: CreateVoiceAgentParams) {
  return createVoiceAgent({
    // LangChain agent configuration
    model: new ChatGoogleGenerativeAI({ model: "gemini-2.5-flash" }),
    tools: [addToOrder, confirmOrder, hangUp],
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: new MemorySaver(),

    // Voice configuration
    stt: new AssemblyAISpeechToText({
      apiKey: process.env.ASSEMBLYAI_API_KEY!,
      sampleRate: 16000,
      // User-provided callback for additional barge-in handling (e.g., clearing audio buffer)
      onSpeechStart: params.onSpeechStart,
    }),
    tts: new ElevenLabsTextToSpeech({
      apiKey: process.env.ELEVENLABS_API_KEY!,
      voiceId: process.env.ELEVENLABS_VOICE_ID!,
      onAudioComplete: () => {
        if (pendingHangUp && params.closeConnection) {
          params.closeConnection(pendingHangUp);
          pendingHangUp = null;
        }
      },
    }),
    middleware: [fillerMiddleware],

    // Callbacks
    onInterrupt: (value: unknown) => {
      console.log("[VoiceAgent] Interrupt:", value);
    },
    onHangUp: (reason: string) => {
      console.log("[VoiceAgent] Hang up requested:", reason);
      pendingHangUp = reason;
    },
  });
}
