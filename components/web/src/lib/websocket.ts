import type { ServerEvent } from "./types";
import {
  session,
  currentTurn,
  latencyStats,
  waterfallData,
  activities,
  logs,
} from "./stores";
import { createAudioCapture, createAudioPlayback } from "./audio";
import { get } from "svelte/store";

export interface VoiceSession {
  start: () => Promise<void>;
  stop: () => void;
}

export function createVoiceSession(): VoiceSession {
  let ws: WebSocket | null = null;
  let ttsFinishTimeout: ReturnType<typeof setTimeout> | null = null;

  const audioCapture = createAudioCapture();
  const audioPlayback = createAudioPlayback();

  function handleEvent(event: ServerEvent) {
    const turn = get(currentTurn);

    switch (event.type) {
      case "stt_chunk":
        if (!turn.active) {
          // New turn - save previous waterfall data and reset
          const prevTurn = get(currentTurn);
          if (prevTurn.turnStartTs) {
            waterfallData.set({ ...prevTurn });
          }
          currentTurn.startTurn(event.ts);
        }
        currentTurn.sttStart(event.ts);
        currentTurn.sttChunk(event.transcript);
        break;

      case "stt_output":
        currentTurn.sttEnd(event.ts, event.transcript);
        activities.add("stt", "Transcription", event.transcript);
        break;

      case "agent_chunk":
        currentTurn.agentChunk(event.ts, event.text);
        break;

      case "tool_call":
        activities.add(
          "tool",
          `Tool: ${event.name}`,
          "Called with arguments:",
          event.args
        );
        logs.log(`Tool call: ${event.name}`);
        break;

      case "tool_result":
        activities.add("tool", `Tool Result: ${event.name}`, event.result);
        logs.log(`Tool result: ${event.result}`);
        break;

      case "tts_chunk": {
        const currentTurnState = get(currentTurn);
        if (!currentTurnState.ttsStartTs && currentTurnState.response) {
          activities.add("agent", "Agent Response", currentTurnState.response);
        }
        currentTurn.ttsChunk(event.ts);
        audioPlayback.push(event.audio);

        // Debounce: finish turn after TTS stops
        if (ttsFinishTimeout) clearTimeout(ttsFinishTimeout);
        ttsFinishTimeout = setTimeout(() => {
          const t = get(currentTurn);
          if (t.active && t.sttEndTs && t.ttsEndTs) {
            finishTurn();
          }
        }, 300);
        break;
      }
    }
  }

  function finishTurn() {
    const turn = get(currentTurn);
    waterfallData.set({ ...turn });
    latencyStats.recordTurn(turn);
    currentTurn.finishTurn();
  }

  async function start(): Promise<void> {
    // Reset all state
    session.reset();
    currentTurn.reset();
    latencyStats.reset();
    waterfallData.set(null);
    activities.clear();
    logs.clear();
    audioPlayback.stop();

    session.setStatus("connecting");

    // Connect WebSocket
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";

    ws.onopen = async () => {
      session.connect();
      logs.log("Session started");

      try {
        await audioCapture.start((chunk) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(chunk);
          }
        });
        logs.log("Microphone access granted");
        logs.log("Streaming PCM audio (16kHz, 16-bit, mono)");
      } catch (err) {
        console.error(err);
        logs.log(
          `Error: ${err instanceof Error ? err.message : "Unknown error"}`
        );
        session.setStatus("error");
        stop();
      }
    };

    ws.onmessage = async (event) => {
      const eventData: ServerEvent = JSON.parse(event.data);
      handleEvent(eventData);
    };

    ws.onclose = () => {
      session.disconnect();
      logs.log("WebSocket disconnected");
    };

    ws.onerror = (e) => {
      console.error(e);
      logs.log("WebSocket error");
      session.setStatus("error");
    };
  }

  function stop(): void {
    logs.log("Session ended");

    if (ttsFinishTimeout) {
      clearTimeout(ttsFinishTimeout);
      ttsFinishTimeout = null;
    }

    audioPlayback.stop();
    audioCapture.stop();

    if (ws) {
      ws.close();
      ws = null;
    }

    session.reset();
  }

  return { start, stop };
}
