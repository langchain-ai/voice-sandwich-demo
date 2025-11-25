/**
 * WebSocket-based pipeline visualizer that streams metrics to the frontend.
 */

import type { WSContext } from "hono/ws";

import type { StageMetrics, LatencyData } from "./LangChainAudioReadableStream";

/** Latency stats for a stage */
interface LatencyStats {
  min: number | null;
  max: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export type PipelineEvent =
  | { type: "stage_registered"; stageName: string; shortName: string; color: string }
  | { type: "turn_start"; stageName: string; turnNumber: number }
  | { type: "stage_input"; stageName: string; turnNumber: number; chunkPreview?: string }
  | { type: "stage_processing"; stageName: string; turnNumber: number }
  | { type: "first_chunk"; stageName: string; turnNumber: number; ttfc: number; chunkPreview?: string }
  | { type: "chunk"; stageName: string; metrics: SerializedStageMetrics; chunkPreview?: string }
  | { type: "latency_update"; stageName: string; shortName: string; latency: LatencyEventData }
  | { type: "stage_complete"; stageName: string; metrics: SerializedStageMetrics }
  | { type: "pipeline_summary"; stages: SerializedStageMetrics[] };

interface LatencyEventData {
  turnNumber: number;
  ttfc: number | null;
  inputToOutput: number | null;
  interChunkAvg: number | null;
  stats: LatencyStats;
}

interface SerializedStageMetrics {
  name: string;
  shortName: string;
  chunksProcessed: number;
  totalBytes: number;
  currentTurn: number;
  turns: Array<{
    turnNumber: number;
    chunksProcessed: number;
    totalBytes: number;
    ttfc: number | null;
  }>;
}

interface StageState {
  name: string;
  shortName: string;
  color: string;
}

const STAGE_COLORS = [
  "#06b6d4", // cyan
  "#22c55e", // green
  "#eab308", // yellow
  "#a855f7", // purple
  "#3b82f6", // blue
  "#ef4444", // red
];

export class PipelineVisualizer {
  private ws: WSContext | null = null;
  private stages: Map<string, StageState> = new Map();
  private stageOrder: string[] = [];

  /**
   * Set the WebSocket connection to stream events to
   */
  setWebSocket(ws: WSContext): void {
    this.ws = ws;
    
    // Send current state to newly connected client
    for (const [stageName, state] of this.stages) {
      this.send({
        type: "stage_registered",
        stageName,
        shortName: state.shortName,
        color: state.color,
      });
    }
  }

  /**
   * Clear the WebSocket connection
   */
  clearWebSocket(): void {
    this.ws = null;
  }

  /**
   * Register a stage in the pipeline
   */
  registerStage(stageName: string): void {
    if (this.stages.has(stageName)) return;

    const index = this.stageOrder.length;
    const shortName = this.extractShortName(stageName);
    const color = STAGE_COLORS[index % STAGE_COLORS.length];

    this.stages.set(stageName, { name: stageName, shortName, color });
    this.stageOrder.push(stageName);

    this.send({
      type: "stage_registered",
      stageName,
      shortName,
      color,
    });
  }

  /**
   * Extract a short name from stage name
   */
  private extractShortName(stageName: string): string {
    const nameMap: Record<string, string> = {
      AssemblyAISTTTransform: "STT",
      AgentTransform: "Agent",
      AIMessageChunkTransform: "Chunker",
      HumeTTSTransform: "TTS",
      ElevenLabsTTSTransform: "TTS",
      SentenceChunkTransform: "Sentence",
    };

    for (const [key, value] of Object.entries(nameMap)) {
      if (stageName.includes(key)) return value;
    }

    const match = stageName.match(/\d+\.\s*(\w+)/);
    if (match) {
      return match[1].slice(0, 10);
    }
    return stageName.slice(0, 10);
  }

  /**
   * Called when a new turn starts
   */
  onTurnStart(stageName: string, turnNumber: number): void {
    this.send({
      type: "turn_start",
      stageName,
      turnNumber,
    });
  }

  /**
   * Called when a stage receives input (data written to writable)
   */
  onInput(stageName: string, turnNumber: number, chunkPreview?: string): void {
    this.send({
      type: "stage_input",
      stageName,
      turnNumber,
      chunkPreview,
    });
  }

  /**
   * Called when a stage starts processing (input received, waiting for output)
   */
  onProcessing(stageName: string, turnNumber: number): void {
    this.send({
      type: "stage_processing",
      stageName,
      turnNumber,
    });
  }

  /**
   * Called when first chunk of a turn arrives
   */
  onFirstChunk(stageName: string, turnNumber: number, ttfc: number, chunkPreview?: string): void {
    this.send({
      type: "first_chunk",
      stageName,
      turnNumber,
      ttfc,
      chunkPreview,
    });
  }

  /**
   * Called when a stage receives a chunk
   */
  onChunk(stageName: string, metrics: StageMetrics, chunkPreview?: string): void {
    const state = this.stages.get(stageName);
    if (!state) return;

    this.send({
      type: "chunk",
      stageName,
      metrics: this.serializeMetrics(stageName, metrics),
      chunkPreview,
    });
  }

  /**
   * Called when latency data is updated for a stage
   */
  onLatencyUpdate(latency: LatencyData): void {
    const state = this.stages.get(latency.stageName);
    if (!state) return;

    this.send({
      type: "latency_update",
      stageName: latency.stageName,
      shortName: state.shortName,
      latency: {
        turnNumber: latency.turnNumber,
        ttfc: latency.ttfc,
        inputToOutput: latency.inputToOutput,
        interChunkAvg: latency.interChunkAvg,
        stats: latency.stats,
      },
    });
  }

  /**
   * Called when a stage completes
   */
  onStageComplete(stageName: string, metrics: StageMetrics): void {
    this.send({
      type: "stage_complete",
      stageName,
      metrics: this.serializeMetrics(stageName, metrics),
    });
  }

  /**
   * Send final summary
   */
  sendSummary(allMetrics: Map<string, StageMetrics>): void {
    const stages: SerializedStageMetrics[] = [];
    for (const [stageName, metrics] of allMetrics) {
      stages.push(this.serializeMetrics(stageName, metrics));
    }
    
    this.send({
      type: "pipeline_summary",
      stages,
    });
  }

  private serializeMetrics(stageName: string, metrics: StageMetrics): SerializedStageMetrics {
    const state = this.stages.get(stageName);
    return {
      name: metrics.name,
      shortName: state?.shortName ?? stageName,
      chunksProcessed: metrics.chunksProcessed,
      totalBytes: metrics.totalBytes,
      currentTurn: metrics.turns.length + (metrics.currentTurn ? 1 : 0),
      turns: metrics.turns.map((t) => ({
        turnNumber: t.turnNumber,
        chunksProcessed: t.chunksProcessed,
        totalBytes: t.totalBytes,
        ttfc: t.firstChunkAt ? t.firstChunkAt - t.startedAt : null,
      })),
    };
  }

  private send(event: PipelineEvent): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(event));
    }
  }
}

