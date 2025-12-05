export namespace VoiceAgentEvent {
  /**
   * Base interface for all voice agent events.
   *
   * All events in the pipeline share these common properties to enable
   * consistent handling, logging, and debugging across the system.
   */
  interface BaseEvent {
    /**
     * Discriminator field identifying the specific event type.
     * Used for type narrowing in TypeScript and event routing.
     */
    type: string;

    /**
     * Unix timestamp (milliseconds since epoch) when the event was created.
     * Useful for measuring latency between pipeline stages and debugging timing issues.
     */
    ts: number;
  }

  /**
   * Event emitted when raw audio data is received from the user.
   *
   * This is the entry point of the voice agent pipeline. Audio should be
   * in PCM format (16-bit, mono, 16kHz) for optimal processing by the STT stage.
   */
  export interface UserInput extends BaseEvent {
    readonly type: "user_input";

    /**
     * Raw PCM audio bytes from the user's microphone.
     * Expected format: 16-bit signed integer, mono channel, 16kHz sample rate.
     */
    audio: Uint8Array;
  }

  /**
   * Event emitted during speech-to-text processing for partial transcription results.
   *
   * STT services often provide incremental results as they process audio.
   * These chunks allow for real-time display of transcription progress to the user,
   * improving perceived responsiveness even before the final transcript is ready.
   */
  export interface STTChunk extends BaseEvent {
    readonly type: "stt_chunk";

    /**
     * Partial transcript text from the STT service.
     * This may be revised as more audio context becomes available.
     * Not guaranteed to be the final transcription.
     */
    transcript: string;
  }

  /**
   * Event emitted when speech-to-text processing completes for a turn.
   *
   * This represents the final, formatted transcription of the user's speech.
   * Unlike STTChunk, this is the complete and finalized transcript that will
   * be sent to the agent for processing.
   */
  export interface STTOutput extends BaseEvent {
    readonly type: "stt_output";

    /**
     * Final, complete transcript of the user's speech for this turn.
     * This is the text that will be processed by the LLM agent.
     */
    transcript: string;
  }

  /**
   * Union type representing all speech-to-text related events.
   *
   * This type encompasses both partial transcription results (STTChunk) and
   * final transcription output (STTOutput) from the STT processing stage.
   * It allows for type-safe handling of all STT events in the voice agent pipeline.
   */
  export type STTEvent = STTChunk | STTOutput;

  /**
   * Event emitted during agent response generation for streaming text chunks.
   *
   * As the LLM generates its response, it streams tokens incrementally.
   * These chunks enable real-time display of the agent's response and allow
   * the TTS stage to begin synthesis before the complete response is generated,
   * reducing overall latency.
   */
  export interface AgentChunk extends BaseEvent {
    readonly type: "agent_chunk";

    /**
     * Partial text chunk from the agent's streaming response.
     * Multiple chunks combine to form the complete agent output.
     */
    text: string;
  }

  // interface AgentInterrupt extends BaseEvent {}

  /**
   * Event emitted during text-to-speech synthesis for streaming audio chunks.
   *
   * As the TTS service synthesizes speech, it streams audio incrementally.
   * These chunks enable real-time playback of the agent's response, allowing
   * audio to begin playing before the complete synthesis is finished, which
   * significantly improves perceived responsiveness.
   */
  export interface TTSChunk extends BaseEvent {
    readonly type: "tts_chunk";

    /**
     * PCM audio bytes synthesized from the agent's text response.
     * Format: 16-bit signed integer, mono channel, 16kHz sample rate.
     * Can be played immediately as it arrives for low-latency audio output.
     */
    audio: Uint8Array;
  }
}

/**
 * Union type of all possible voice agent events.
 *
 * This type enables type-safe event handling throughout the voice agent pipeline.
 * TypeScript can use the discriminator `type` field to narrow the union to the
 * specific event interface, providing full type safety and autocomplete for
 * event-specific properties.
 *
 * @example
 * ```typescript
 * function handleEvent(event: VoiceAgentEvent) {
 *   switch (event.type) {
 *     case "user_input":
 *       processAudio(event.audio);
 *       break;
 *     case "stt_output":
 *       sendToAgent(event.transcript);
 *       break;
 *     // ... handle other event types
 *   }
 * }
 * ```
 */
export type VoiceAgentEvent =
  | VoiceAgentEvent.UserInput
  | VoiceAgentEvent.STTChunk
  | VoiceAgentEvent.STTOutput
  | VoiceAgentEvent.AgentChunk
  | VoiceAgentEvent.TTSChunk;
