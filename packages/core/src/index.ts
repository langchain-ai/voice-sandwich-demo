/**
 * @voice-sandwich-demo/core
 * 
 * Core building blocks for creating voice agents with LangChain.
 */

// Models
export {
  BaseSpeechToTextModel,
  BaseTextToSpeechModel,
  type SpeechToTextModelParams,
  type TextToSpeechModelParams,
} from "./models.js";

// Middleware
export {
  createVoiceMiddleware,
  combineVoiceMiddleware,
  pipeThroughTransforms,
  type VoiceMiddleware,
  type VoiceMiddlewareHooks,
} from "./middleware.js";

// Voice Agent
export {
  createVoiceAgent,
  type CreateVoiceAgentParams,
  type VoiceAgent,
} from "./agent.js";

// Built-in Middleware
export {
  ThinkingFillerTransform,
  createThinkingFillerMiddleware,
  type ThinkingFillerOptions,
} from "./thinking-filler.js";

export {
  createPipelineVisualizerMiddleware,
  type PipelineVisualizerOptions,
  type PipelineEvent,
  type StageMetrics,
  type LatencyData,
} from "./pipeline-visualizer.js";

// Utilities
export {
  VADBufferTransform,
  type VADBufferOptions,
} from "./vad.js";

