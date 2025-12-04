/**
 * Message types received from ElevenLabs streaming API
 */
export interface ElevenLabsTTSMessage {
  /** Base64 encoded audio chunk */
  audio?: string;
  /** Whether this is the final message for the current generation */
  isFinal?: boolean;
  /** Normalized alignment information (if requested) */
  normalizedAlignment?: {
    char_start_times_ms: number[];
    chars_durations_ms: number[];
    chars: string[];
  };
  /** Alignment information (if requested) */
  alignment?: {
    char_start_times_ms: number[];
    chars_durations_ms: number[];
    chars: string[];
  };
  /** Error information if something went wrong */
  error?: {
    message: string;
    code: number;
    status: string;
  };
}

/**
 * Initial message sent to start the stream (BOS)
 */
export interface ElevenLabsBOSMessage {
  text: string;
  voice_settings: {
    stability: number;
    similarity_boost: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
  generation_config?: {
    chunk_length_schedule: number[];
  };
  xi_api_key: string;
}

/**
 * Text chunk message sent during streaming
 */
export interface ElevenLabsTextMessage {
  text: string;
  try_trigger_generation?: boolean;
  generation_config?: {
    chunk_length_schedule: number[];
  };
}
