/**
 * Audio encoding formats supported by AssemblyAI streaming API
 */
export type AssemblyAIEncoding = "pcm_s16le" | "pcm_mulaw";

/**
 * Speech model options for AssemblyAI streaming
 * - universal-streaming-english: English-only (default, lower latency)
 * - universal-streaming-multi: Multilingual (English, Spanish, French, German, Italian, Portuguese)
 */
export type AssemblyAISpeechModel =
  | "universal-streaming-english"
  | "universal-streaming-multi";

/**
 * Region options for AssemblyAI streaming API
 * - us: US endpoint (default) - streaming.assemblyai.com
 * - eu: EU endpoint - streaming.eu.assemblyai.com
 */
export type AssemblyAIRegion = "us" | "eu";

/**
 * Word-level transcription data
 */
export interface AssemblyAIWord {
  /** The string representation of the word */
  text: string;
  /** Whether the word is finalized and won't change */
  word_is_final: boolean;
  /** Timestamp for word start (in milliseconds) */
  start: number;
  /** Timestamp for word end (in milliseconds) */
  end: number;
  /** Confidence score for the word (0-1) */
  confidence: number;
}

/**
 * Turn event data with full transcription details
 */
export interface AssemblyAITurnEvent {
  /** Integer that increments with each new turn */
  turn_order: number;
  /** Whether the text is formatted (punctuation, casing, ITN) */
  turn_is_formatted: boolean;
  /** Whether this is the end of the current turn */
  end_of_turn: boolean;
  /** The transcript text (only finalized words) */
  transcript: string;
  /** Confidence that the current turn has finished (0-1) */
  end_of_turn_confidence: number;
  /** List of Word objects with individual metadata */
  words: AssemblyAIWord[];
}

/**
 * Message types received from AssemblyAI streaming API
 */
export namespace AssemblyAISTTMessage {
  export enum Type {
    Begin = "Begin",
    Turn = "Turn",
    Termination = "Termination",
    Error = "Error",
  }

  /**
   * Session initialization message
   * Sent when the WebSocket connection is established
   */
  export interface Begin {
    /** Message type identifier */
    type: Type.Begin;
    /** Unique session identifier */
    id: string;
    /** Unix timestamp (in seconds) when the session expires */
    expires_at: number;
  }

  /**
   * Turn event message containing transcription results
   * Sent during active transcription as speech is processed
   */
  export interface Turn {
    /** Message type identifier */
    type: Type.Turn;
    /** Integer that increments with each new turn */
    turn_order: number;
    /** Whether the text is formatted (punctuation, casing, ITN) */
    turn_is_formatted: boolean;
    /** Whether this is the end of the current turn */
    end_of_turn: boolean;
    /** The transcript text (only finalized words) */
    transcript: string;
    /** Confidence that the current turn has finished (0-1) */
    end_of_turn_confidence: number;
    /** List of Word objects with individual metadata */
    words: AssemblyAIWord[];
  }

  /**
   * Session termination message
   * Sent when the session ends (after receiving termination message from client)
   */
  export interface Termination {
    /** Message type identifier */
    type: Type.Termination;
    /** Total duration of audio processed in seconds */
    audio_duration_seconds: number;
    /** Total duration of the session in seconds */
    session_duration_seconds: number;
  }

  /**
   * Error message
   * Sent when an error occurs during the session
   */
  export interface Error {
    /** Message type identifier */
    type: Type.Error;
    /** Error message describing what went wrong */
    error: string;
  }
}

/**
 * Union type of all possible messages from AssemblyAI streaming API
 */
export type AssemblyAISTTMessage =
  | AssemblyAISTTMessage.Begin
  | AssemblyAISTTMessage.Turn
  | AssemblyAISTTMessage.Termination
  | AssemblyAISTTMessage.Error;
