/**
 * Voice Agent - Main abstraction for creating voice-enabled agents.
 * Extends LangChain's agent concept with voice-specific features.
 */

import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { createAgent, type CreateAgentParams, type ReactAgent } from "langchain";

import {
  combineVoiceMiddleware,
  pipeThroughTransforms,
  type VoiceMiddleware,
  type VoiceMiddlewareHooks,
} from "./middleware.js";
import { type BaseSpeechToTextModel, type BaseTextToSpeechModel } from "./models.js";

/**
 * Parameters for creating a voice agent.
 * Extends LangChain's CreateAgentParams with voice-specific options.
 */
export interface CreateVoiceAgentParams extends CreateAgentParams {
  /** Speech-to-Text model for transcribing user input */
  stt: BaseSpeechToTextModel;
  /** Text-to-Speech model for generating audio output */
  tts: BaseTextToSpeechModel;
  /** Optional middleware for customizing the pipeline */
  middleware?: VoiceMiddleware[];
  /** Callback when an interrupt occurs */
  onInterrupt?: (value: unknown) => void;
  /** Callback when the agent calls hang_up tool */
  onHangUp?: (reason: string) => void;
}

/**
 * Voice Agent interface - represents a voice-enabled agent.
 */
export interface VoiceAgent {
  /** The underlying LangGraph agent */
  readonly agent: ReactAgent;
  /** The TTS model (useful for interrupt/barge-in control) */
  readonly tts: BaseTextToSpeechModel;
  /** The STT model */
  readonly stt: BaseSpeechToTextModel;
  /** Start processing audio from a readable stream */
  process(audioInput: ReadableStream<Buffer>): ReadableStream<Buffer>;
  /** Stop processing and clean up */
  stop(): void;
}

/**
 * Internal state for the voice agent.
 */
interface VoiceAgentState {
  threadId: string;
  pendingInterrupt?: unknown;
  stopped: boolean;
}

/**
 * Creates a voice agent with the specified configuration.
 * 
 * This function creates a LangChain agent internally using `createAgent()`
 * and wraps it with voice capabilities (STT, TTS, middleware).
 * 
 * @example
 * ```ts
 * import { createVoiceAgent } from "@voice-sandwich-demo/core";
 * import { AssemblyAISpeechToText } from "@voice-sandwich-demo/assemblyai";
 * import { ElevenLabsTextToSpeech } from "@voice-sandwich-demo/elevenlabs";
 * 
 * const voiceAgent = createVoiceAgent({
 *   // LangChain agent params
 *   model: new ChatOpenAI({ model: "gpt-4" }),
 *   tools: [myTool],
 *   systemPrompt: "You are a helpful assistant.",
 *   checkpointer: new MemorySaver(),
 *   
 *   // Voice-specific params
 *   stt: new AssemblyAISpeechToText({ apiKey: "..." }),
 *   tts: new ElevenLabsTextToSpeech({ apiKey: "...", voiceId: "..." })
 * });
 * 
 * const audioOutput = voiceAgent.process(audioInput);
 * ```
 */
export function createVoiceAgent(params: CreateVoiceAgentParams): VoiceAgent {
  const { 
    stt, 
    tts, 
    middleware = [], 
    onInterrupt, 
    onHangUp,
    // Extract CreateAgentParams
    ...agentParams
  } = params;
  
  // Create the LangChain agent using createAgent()
  const agent = createAgent(agentParams);
  
  const state: VoiceAgentState = {
    threadId: crypto.randomUUID(),
    stopped: false,
  };
  
  // Combine all middleware
  const hooks = middleware.length > 0 
    ? combineVoiceMiddleware(...middleware)
    : {} as VoiceMiddlewareHooks;

  // Wire middleware event hooks to STT/TTS models
  if (hooks.onSpeechStart) {
    stt.addSpeechStartListener(hooks.onSpeechStart);
  }
  if (hooks.onAudioComplete) {
    tts.addAudioCompleteListener(hooks.onAudioComplete);
  }

  /**
   * Creates the agent transform that processes text through the LangGraph agent.
   */
  function createAgentTransform(): TransformStream<string, string> {
    return new TransformStream<string, string>({
      async transform(text, controller) {
        if (state.stopped) return;
        
        let input: { messages: HumanMessage[] } | Command;

        // If there's a pending interrupt, resume with Command
        if (state.pendingInterrupt !== undefined) {
          console.log("[VoiceAgent] Resuming from interrupt with user response:", text);
          input = new Command({ resume: text });
          state.pendingInterrupt = undefined;
        } else {
          input = { messages: [new HumanMessage(text)] };
        }

        const graphStream = await agent.stream(input, {
          configurable: { thread_id: state.threadId },
          streamMode: "messages",
        });

        for await (const [chunk] of graphStream) {
          if (state.stopped) break;
          
          // Check if it's an AIMessageChunk - extract text content
          if (chunk && typeof chunk === "object" && "content" in chunk) {
            const content = (chunk as { content: unknown }).content;
            if (typeof content === "string" && content.length > 0) {
              controller.enqueue(content);
            }
          }
          
          // Check for hang_up tool
          if (chunk && typeof chunk === "object" && "name" in chunk) {
            const toolChunk = chunk as { name: string; content: unknown };
            if (toolChunk.name === "hang_up" && onHangUp) {
              console.log("[VoiceAgent] Hang up tool called:", toolChunk.content);
              onHangUp(toolChunk.content as string);
            }
          }
        }

        // Check for interrupts
        const graphState = await agent.getState({
          configurable: { thread_id: state.threadId },
        }) as { tasks?: Array<{ interrupts?: Array<{ value: unknown }> }> };

        if (graphState.tasks) {
          for (const task of graphState.tasks) {
            if (task.interrupts && task.interrupts.length > 0) {
              const interruptValue = task.interrupts[0].value;
              console.log("[VoiceAgent] Interrupt detected:", interruptValue);
              state.pendingInterrupt = interruptValue;
              onInterrupt?.(interruptValue);
              
              // Emit interrupt message
              if (typeof interruptValue === "string") {
                controller.enqueue(interruptValue);
              }
            }
          }
        }
      },
    });
  }

  return {
    agent,
    tts,
    stt,
    
    process(audioInput: ReadableStream<Buffer>): ReadableStream<Buffer> {
      // Build the pipeline with middleware hooks
      
      // Step 1: Apply beforeSTT transforms
      let pipeline: ReadableStream<Buffer> = audioInput;
      if (hooks.beforeSTT && hooks.beforeSTT.length > 0) {
        pipeline = pipeThroughTransforms(pipeline, hooks.beforeSTT);
      }
      
      // Step 2: Speech-to-Text
      let textStream: ReadableStream<string> = pipeline.pipeThrough(stt);
      
      // Step 3: Apply afterSTT transforms
      if (hooks.afterSTT && hooks.afterSTT.length > 0) {
        textStream = pipeThroughTransforms(textStream, hooks.afterSTT);
      }
      
      // Step 4: Agent processing
      let agentOutput = textStream.pipeThrough(createAgentTransform());
      
      // Step 5: Apply beforeTTS transforms
      if (hooks.beforeTTS && hooks.beforeTTS.length > 0) {
        agentOutput = pipeThroughTransforms(agentOutput, hooks.beforeTTS);
      }
      
      // Step 6: Text-to-Speech
      let audioOutput: ReadableStream<Buffer> = agentOutput.pipeThrough(tts);
      
      // Step 7: Apply afterTTS transforms
      if (hooks.afterTTS && hooks.afterTTS.length > 0) {
        audioOutput = pipeThroughTransforms(audioOutput, hooks.afterTTS);
      }
      
      return audioOutput;
    },
    
    stop() {
      state.stopped = true;
      // Interrupt TTS if possible
      tts.interrupt();
    },
  };
}
