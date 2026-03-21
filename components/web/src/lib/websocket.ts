import type { ServerEvent } from "./types";
import {
  session,
  currentTurn,
  waterfallData,
  activities,
  logs,
  detailedStream,
  latencyStats,
} from "./stores";
import { get } from "svelte/store";
import { createAudioCapture } from "./audio";
import { createAudioPlayback } from "./audio";

export interface VoiceSession {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createVoiceSession(): VoiceSession {
  let ws: WebSocket | null = null;
  const audioCapture = createAudioCapture();
  const audioPlayback = createAudioPlayback();
  let isUserSpeaking = false;

  function handleEvent(event: ServerEvent): void {
    const turn = get(currentTurn);
    switch (event.type) {
      case "error": {
        logs.log(`Server error: ${event.message}`);
        session.setStatus("error");
        break;
      }
      case "stt_chunk": {
        if (!turn.active) {
          currentTurn.startTurn(event.ts);
          currentTurn.sttStart(event.ts);
        }
        currentTurn.sttChunk(event.transcript);
        break;
      }
      case "stt_output": {
        if (!turn.active) {
          currentTurn.startTurn(event.ts);
          currentTurn.sttStart(event.ts);
        }
        currentTurn.sttEnd(event.ts, event.transcript);
        activities.add("stt", "You", `You: ${event.transcript}`);
        waterfallData.set({ ...get(currentTurn) });
        currentTurn.finishTurn();
        break;
      }
      case "voice_output_stream": {
        // Always prioritize newest voice output.
        audioPlayback.stop();
        audioPlayback.resetScheduling();
        currentTurn.startTurn(event.ts);
        currentTurn.agentStart(event.ts);
        currentTurn.agentChunk(event.ts, event.text);
        activities.add("agent", "AI", `AI: ${event.text}`);
        break;
      }
      case "detailed_output_stream": {
        detailedStream.append(event.task_id, event.text, event.ts);
        break;
      }
      case "ai_audio": {
        if (isUserSpeaking) {
          break;
        }
        if (!turn.active) {
          currentTurn.startTurn(event.ts);
        }
        currentTurn.ttsChunk(event.ts);
        audioPlayback.push(event.audio);
        break;
      }
      case "ai_audio_end": {
        const snapshot = { ...get(currentTurn) };
        waterfallData.set(snapshot);
        latencyStats.recordTurn(snapshot);
        currentTurn.finishTurn();
        break;
      }
      default:
        // Ignore unknown events.
        break;
    }
  }

  async function start(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    session.setStatus("connecting");
    currentTurn.reset();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";

    ws.onopen = async () => {
      session.connect();
      logs.log("Session started");
      try {
        await audioCapture.start(
          (chunk) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
            }
          },
          {
            rmsThreshold: Number(import.meta.env.VITE_SPEECH_INTERRUPT_RMS_THRESHOLD ?? 0.04),
            minSpeechMs: Number(import.meta.env.VITE_SPEECH_INTERRUPT_MIN_MS ?? 1000),
            onSpeechStateChange: (speaking) => {
              isUserSpeaking = speaking;
              if (speaking) {
                audioPlayback.stop();
                audioPlayback.resetScheduling();
              }
            },
          }
        );
        logs.log("Streaming PCM audio to websocket");
      } catch (error) {
        console.error(error);
        logs.log("Microphone initialization failed");
        session.setStatus("error");
        await stop();
      }
    };

    ws.onmessage = (event) => {
      const eventData = JSON.parse(event.data) as ServerEvent;
      handleEvent(eventData);
    };

    ws.onerror = (error) => {
      console.error(error);
      logs.log("WebSocket error");
      session.setStatus("error");
    };

    ws.onclose = () => {
      audioCapture.stop();
      isUserSpeaking = false;
      session.disconnect();
      logs.log("Session ended");
      ws = null;
    };
  }

  async function stop(): Promise<void> {
    audioCapture.stop();
    audioPlayback.stop();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "session ended");
    }
  }

  return { start, stop };
}
