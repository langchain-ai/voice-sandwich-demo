/**
 * Voice configuration for Cartesia TTS
 */
export interface CartesiaVoice {
  /** Voice selection mode */
  mode: "id";
  /** Voice ID from Cartesia's voice library */
  id: string;
}

/**
 * Output format configuration for Cartesia TTS
 */
export interface CartesiaOutputFormat {
  /** Container format - "raw" for streaming */
  container: "raw";
  /** Audio encoding */
  encoding: "pcm_s16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw";
  /** Sample rate in Hz */
  sample_rate: number;
}

/**
 * Request message sent to Cartesia WebSocket for TTS
 */
export interface CartesiaTTSRequest {
  /** Model ID to use for synthesis */
  model_id: string;
  /** Text to synthesize */
  transcript: string;
  /** Voice configuration */
  voice: CartesiaVoice;
  /** Output format configuration */
  output_format: CartesiaOutputFormat;
  /** Optional context ID for continuations */
  context_id?: string;
  /** Whether this continues a previous context */
  continue?: boolean;
  /** Language code (e.g., "en") */
  language?: string;
}

/**
 * Response message received from Cartesia WebSocket
 */
export interface CartesiaTTSResponse {
  /** Status code for the response */
  status_code?: number;
  /** Whether generation is complete for this context */
  done?: boolean;
  /** Context ID for this generation */
  context_id?: string;
  /** Base64 encoded audio data */
  data?: string;
  /** Error information if something went wrong */
  error?: string;
  /** Message type */
  type?: "chunk" | "done" | "error";
}
