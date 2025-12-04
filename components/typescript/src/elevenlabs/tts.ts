import WebSocket from "ws";
import { writableIterator } from "../utils";
import type {
  ElevenLabsTTSMessage,
  ElevenLabsBOSMessage,
  ElevenLabsTextMessage,
} from "./api-types";
import type { VoiceAgentEvent } from "../types";

interface ElevenLabsTTSOptions {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  outputFormat?: string;
  triggerGeneration?: boolean;
}

export class ElevenLabsTTS {
  apiKey: string;
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  outputFormat: string;
  triggerGeneration: boolean;

  protected _bufferIterator = writableIterator<VoiceAgentEvent.TTSChunk>();
  protected _connectionPromise: Promise<WebSocket> | null = null;
  protected get _connection(): Promise<WebSocket> {
    if (this._connectionPromise) {
      return this._connectionPromise;
    }

    this._connectionPromise = new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model_id: this.modelId,
        output_format: this.outputFormat,
      });
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?${params.toString()}`;
      const ws = new WebSocket(url);

      ws.on("open", () => {
        const bosMessage: ElevenLabsBOSMessage = {
          text: " ",
          voice_settings: {
            stability: this.stability,
            similarity_boost: this.similarityBoost,
          },
          xi_api_key: this.apiKey,
        };
        ws.send(JSON.stringify(bosMessage));
        resolve(ws);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const message: ElevenLabsTTSMessage = JSON.parse(data.toString());

          if (message.audio) {
            const audioChunk = Buffer.from(message.audio, "base64");
            if (audioChunk.length > 0) {
              this._bufferIterator.push({ type: "tts_chunk", audio: new Uint8Array(audioChunk), ts: Date.now() });
            }
          } else if (message.isFinal) {
            // no-op
          } else if (message.error) {
            throw new Error(
              `ElevenLabs error: ${JSON.stringify(message.error)}`
            );
          }
        } catch (error) {
          // TODO: better catch json parsing error
          console.error(error);
        }
      });

      ws.on("error", (error) => {
        this._bufferIterator.cancel();
        reject(error);
      });

      ws.on("close", () => {
        this._connectionPromise = null;
      });
    });

    return this._connectionPromise;
  }

  constructor(options: ElevenLabsTTSOptions = {}) {
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY || "";
    if (!this.apiKey) {
      throw new Error("ElevenLabs API key is required");
    }
    this.voiceId = options.voiceId || "21m00Tcm4TlvDq8ikWAM"; // Default: Rachel
    this.modelId = options.modelId || "eleven_multilingual_v2";
    this.stability = options.stability ?? 0.5;
    this.similarityBoost = options.similarityBoost ?? 0.75;
    this.outputFormat = options.outputFormat || "pcm_16000";
    this.triggerGeneration = options.triggerGeneration ?? false;
  }

  async sendText(text: string): Promise<void> {
    if (!text || !text.trim()) {
      return;
    }

    const conn = await this._connection;
    if (conn.readyState === WebSocket.OPEN) {
      const payload: ElevenLabsTextMessage = {
        text: text,
        try_trigger_generation: this.triggerGeneration,
      };
      conn.send(JSON.stringify(payload));
    }
  }

  async *receiveEvents(): AsyncGenerator<VoiceAgentEvent.TTSChunk> {
    yield* this._bufferIterator;
  }

  async close(): Promise<void> {
    if (this._connectionPromise) {
      const ws = await this._connectionPromise;
      ws.close();
    }
  }
}
