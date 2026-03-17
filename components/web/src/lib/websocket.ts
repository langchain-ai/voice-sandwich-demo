import type { ServerEvent } from "./types";
import {
  session,
  currentTurn,
  latencyStats,
  waterfallData,
  activities,
  logs,
} from "./stores";
import { get } from "svelte/store";

export interface VoiceSession {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
  playLastRecording: () => void;
}

export function createVoiceSession(): VoiceSession {
  const STOP_TAIL_CAPTURE_MS = 3000;
  let mediaStream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let isStopping = false;
  let currentRecordingChunks: BlobPart[] = [];
  let lastRecordingUrl: string | null = null;
  let lastRecordingAudio: HTMLAudioElement | null = null;

  function saveLastRecording(blob: Blob): void {
    if (lastRecordingAudio) {
      lastRecordingAudio.pause();
      lastRecordingAudio.currentTime = 0;
    }
    if (lastRecordingUrl) {
      URL.revokeObjectURL(lastRecordingUrl);
      lastRecordingUrl = null;
    }
    if (!blob.size) return;

    lastRecordingUrl = URL.createObjectURL(blob);
    lastRecordingAudio = new Audio(lastRecordingUrl);
  }

  function finishTurn() {
    const turn = get(currentTurn);
    waterfallData.set({ ...turn });
    // Keep existing metric shape; only STT data is present in HTTP mode.
    latencyStats.recordTurn(turn);
    currentTurn.finishTurn();
  }

  function pickSupportedMimeType(): string {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
    ];
    for (const candidate of candidates) {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }
    return "";
  }

  function cleanupRecorder(): void {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    mediaRecorder = null;
  }

  async function start(): Promise<void> {
    // Reset per-turn state, but keep historical activity/log output visible.
    session.reset();
    currentTurn.reset();
    latencyStats.reset();
    waterfallData.set(null);

    session.setStatus("connecting");
    currentRecordingChunks = [];
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mimeType = pickSupportedMimeType();
      mediaRecorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream);

      mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          currentRecordingChunks.push(event.data);
        }
      };

      mediaRecorder.start(250);
      session.connect();
      logs.log("Recording started");
    } catch (err) {
      console.error(err);
      logs.log(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      session.setStatus("error");
      cleanupRecorder();
    }
  }

  async function stop(): Promise<void> {
    if (
      isStopping ||
      !mediaRecorder ||
      !mediaStream ||
      mediaRecorder.state !== "recording"
    ) {
      return;
    }

    isStopping = true;
    logs.log(`Stop requested. Capturing ${STOP_TAIL_CAPTURE_MS / 1000}s tail audio...`);

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, STOP_TAIL_CAPTURE_MS);
    });

    // Flush pending encoder buffer before we stop, so tail audio is not dropped.
    mediaRecorder.requestData();
    session.setRecording(false);
    session.setStatus("processing");
    logs.log("Tail capture window ended. Finalizing recording...");

    const stopPromise = new Promise<void>((resolve) => {
      mediaRecorder!.addEventListener("stop", () => resolve(), { once: true });
    });
    mediaRecorder.stop();
    await stopPromise;

    const mimeType = mediaRecorder.mimeType || "audio/webm";
    const recordingBlob = new Blob(currentRecordingChunks, { type: mimeType });
    saveLastRecording(recordingBlob);
    currentRecordingChunks = [];

    cleanupRecorder();

    if (!recordingBlob.size) {
      logs.log("No audio captured");
      session.reset();
      isStopping = false;
      return;
    }

    const startedAt = Date.now();
    currentTurn.startTurn(startedAt);
    currentTurn.sttStart(startedAt);

    const formData = new FormData();
    const extension = mimeType.includes("mp4") ? "m4a" : "webm";
    formData.append("audio", recordingBlob, `recording.${extension}`);
    formData.append("language", "en");

    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Transcription failed (${response.status})`);
      }

      const eventData = (await response.json()) as ServerEvent;
      if (eventData.type !== "stt_output") {
        throw new Error("Unexpected response payload");
      }

      currentTurn.sttEnd(eventData.ts, eventData.transcript);
      activities.add("stt", "Transcription", eventData.transcript);
      logs.log("Transcription received");
      finishTurn();
      session.reset();
      isStopping = false;
    } catch (error) {
      console.error(error);
      logs.log("Failed to transcribe recording");
      session.setStatus("error");
      isStopping = false;
    }
  }

  async function toggle(): Promise<void> {
    const state = get(session);
    if (state.recording) {
      await stop();
      return;
    }
    await start();
  }

  function playLastRecording(): void {
    if (!lastRecordingAudio) {
      logs.log("No recording available to play yet");
      return;
    }

    lastRecordingAudio.currentTime = 0;
    void lastRecordingAudio.play().catch((error) => {
      console.error(error);
      logs.log("Failed to play recording");
    });
  }

  return { start, stop, toggle, playLastRecording };
}
