/**
 * A ReadableStream wrapper that provides observability into transform pipeline stages.
 * Tracks timing, throughput, and logs information about each stage.
 */

import type { PipelineVisualizer } from "./PipelineVisualizer";

interface TurnMetrics {
  turnNumber: number;
  startedAt: number;
  firstChunkAt: number | null;
  lastChunkAt: number | null;
  chunksProcessed: number;
  totalBytes: number;
  /** Time when first meaningful input was received */
  firstInputAt: number | null;
  /** Time to first chunk (output) from turn start */
  ttfc: number | null;
  /** Input-to-output latency (first input to first output) */
  inputToOutputLatency: number | null;
}

/** Latency statistics for a stage */
interface LatencyStats {
  /** Minimum latency observed */
  min: number | null;
  /** Maximum latency observed */
  max: number | null;
  /** Average latency */
  avg: number | null;
  /** All latency samples for percentile calculation */
  samples: number[];
  /** P50 latency */
  p50: number | null;
  /** P95 latency */
  p95: number | null;
  /** P99 latency */
  p99: number | null;
}

interface StageMetrics {
  name: string;
  chunksProcessed: number;
  totalBytes: number;
  firstChunkAt: number | null;
  lastChunkAt: number | null;
  startedAt: number;
  processingTimeMs: number;
  /** Per-turn metrics for this stage */
  turns: TurnMetrics[];
  /** Current turn being processed */
  currentTurn: TurnMetrics | null;
  /** Input-to-output latency stats across all turns */
  latencyStats: LatencyStats;
  /** Inter-chunk latency (time between consecutive output chunks) */
  interChunkLatencies: number[];
  /** Average inter-chunk latency */
  avgInterChunkLatency: number | null;
}

/** Serializable latency data for visualization */
interface LatencyData {
  stageName: string;
  turnNumber: number;
  ttfc: number | null;
  inputToOutput: number | null;
  interChunkAvg: number | null;
  stats: {
    min: number | null;
    max: number | null;
    avg: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
}

/** Common interface for visualizers */
interface VisualizerInterface {
  registerStage(stageName: string): void;
  onTurnStart(stageName: string, turnNumber: number): void;
  onInput(stageName: string, turnNumber: number, chunkPreview?: string): void;
  onProcessing(stageName: string, turnNumber: number): void;
  onFirstChunk(stageName: string, turnNumber: number, ttfc: number, chunkPreview?: string): void;
  onChunk(stageName: string, metrics: StageMetrics, chunkPreview?: string): void;
  onLatencyUpdate(latency: LatencyData): void;
}

interface ObservabilityOptions {
  /** Enable verbose logging for each chunk */
  verbose?: boolean;
  /** Custom logger function (disabled when visualizer is used) */
  logger?: (message: string, data?: Record<string, unknown>) => void;
  /** Callback fired when a stage processes a chunk */
  onChunkProcessed?: (stageName: string, metrics: StageMetrics) => void;
  /** Callback fired when the pipeline completes */
  onPipelineComplete?: (allMetrics: Map<string, StageMetrics>) => void;
  /** 
   * Time in ms after which a new chunk is considered a new "turn" 
   * Default: 1000ms
   */
  turnIdleThresholdMs?: number;
  /**
   * Visualizer for streaming metrics to the frontend.
   * Pass a PipelineVisualizer instance.
   */
  visualizer?: PipelineVisualizer;
}

/** Internal options with resolved visualizer */
interface InternalOptions extends ObservabilityOptions {
  _visualizer?: VisualizerInterface;
}

/** No-op logger for when visualizer is active */
const noopLogger = () => {};

/**
 * Creates an observable TransformStream wrapper that tracks metrics
 */
function createObservableTransform<I, O>(
  transform: TransformStream<I, O>,
  stageName: string,
  metrics: Map<string, StageMetrics>,
  options: InternalOptions
): TransformStream<I, O> {
  const turnIdleThreshold = options.turnIdleThresholdMs ?? 1000;
  const visualizer = options._visualizer;
  
  const stageMetrics: StageMetrics = {
    name: stageName,
    chunksProcessed: 0,
    totalBytes: 0,
    firstChunkAt: null,
    lastChunkAt: null,
    startedAt: Date.now(),
    processingTimeMs: 0,
    turns: [],
    currentTurn: null,
    latencyStats: {
      min: null,
      max: null,
      avg: null,
      samples: [],
      p50: null,
      p95: null,
      p99: null,
    },
    interChunkLatencies: [],
    avgInterChunkLatency: null,
  };
  metrics.set(stageName, stageMetrics);

  // Use no-op logger when visualizer is active to avoid log interference
  const log = visualizer ? noopLogger : (options.logger ?? console.log);

  // Register stage with visualizer
  if (visualizer) {
    visualizer.registerStage(stageName);
  } else {
    log(`[Pipeline] Stage "${stageName}" initialized`, { timestamp: new Date().toISOString() });
  }

  const reader = transform.readable.getReader();
  const writer = transform.writable.getWriter();

  // Track if we're waiting for output (processing state)
  let isProcessing = false;
  let inputTurnNumber = 1;
  // Track pending input timestamp for when input arrives before turn is created
  let pendingInputTimestamp: number | null = null;
  // Track last output time to detect new turn on input side
  let lastOutputTimestamp: number = 0;

  /**
   * Start a new turn for this stage
   */
  function startNewTurn(now: number): TurnMetrics {
    // Finalize previous turn if exists
    if (stageMetrics.currentTurn) {
      finalizeTurnLatency(stageMetrics.currentTurn);
      stageMetrics.turns.push(stageMetrics.currentTurn);
    }
    
    // Use pending input timestamp if available (input arrived before turn started)
    const inputTimestamp = pendingInputTimestamp ?? null;
    pendingInputTimestamp = null; // Clear pending timestamp
    
    const newTurn: TurnMetrics = {
      turnNumber: stageMetrics.turns.length + 1,
      startedAt: inputTimestamp ?? now, // Start from input time if available
      firstChunkAt: null,
      lastChunkAt: null,
      chunksProcessed: 0,
      totalBytes: 0,
      firstInputAt: inputTimestamp,
      ttfc: null,
      inputToOutputLatency: null,
    };
    stageMetrics.currentTurn = newTurn;
    return newTurn;
  }

  /**
   * Finalize latency calculations for a completed turn
   */
  function finalizeTurnLatency(turn: TurnMetrics): void {
    if (turn.inputToOutputLatency !== null) {
      const latency = turn.inputToOutputLatency;
      const stats = stageMetrics.latencyStats;
      
      stats.samples.push(latency);
      stats.min = stats.min === null ? latency : Math.min(stats.min, latency);
      stats.max = stats.max === null ? latency : Math.max(stats.max, latency);
      stats.avg = stats.samples.reduce((a, b) => a + b, 0) / stats.samples.length;
      
      // Calculate percentiles
      const sorted = [...stats.samples].sort((a, b) => a - b);
      stats.p50 = percentile(sorted, 50);
      stats.p95 = percentile(sorted, 95);
      stats.p99 = percentile(sorted, 99);
    }
  }

  /**
   * Calculate percentile from sorted array
   */
  function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  const observableReadable = new ReadableStream<O>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // Finalize last turn
          if (stageMetrics.currentTurn) {
            stageMetrics.turns.push(stageMetrics.currentTurn);
            stageMetrics.currentTurn = null;
          }
          
          const totalDuration = Date.now() - stageMetrics.startedAt;
          log(`[Pipeline] Stage "${stageName}" completed`, {
            chunksProcessed: stageMetrics.chunksProcessed,
            totalBytes: stageMetrics.totalBytes,
            totalDurationMs: totalDuration,
            totalTurns: stageMetrics.turns.length,
            avgChunkSize: stageMetrics.chunksProcessed > 0 
              ? Math.round(stageMetrics.totalBytes / stageMetrics.chunksProcessed) 
              : 0,
          });
          controller.close();
          return;
        }

        const now = Date.now();
        const chunkSize = getChunkSize(value);
        const chunkPreview = getChunkPreview(value);
        const timeSinceLastChunk = stageMetrics.lastChunkAt 
          ? now - stageMetrics.lastChunkAt 
          : Infinity;

        // Detect new turn based on idle threshold
        const isNewTurn = !stageMetrics.currentTurn || timeSinceLastChunk > turnIdleThreshold;
        
        if (isNewTurn) {
          const turn = startNewTurn(now);
          if (visualizer) {
            visualizer.onTurnStart(stageName, turn.turnNumber);
          } else {
            log(`[Pipeline] Stage "${stageName}" turn #${turn.turnNumber} started`, {
              timeSinceLastChunkMs: timeSinceLastChunk === Infinity ? "first" : timeSinceLastChunk,
            });
          }
        }

        // Track inter-chunk latency (time between consecutive chunks)
        if (stageMetrics.lastChunkAt !== null) {
          const interChunkLatency = now - stageMetrics.lastChunkAt;
          stageMetrics.interChunkLatencies.push(interChunkLatency);
          // Keep only last 100 samples for memory efficiency
          if (stageMetrics.interChunkLatencies.length > 100) {
            stageMetrics.interChunkLatencies.shift();
          }
          stageMetrics.avgInterChunkLatency = 
            stageMetrics.interChunkLatencies.reduce((a, b) => a + b, 0) / 
            stageMetrics.interChunkLatencies.length;
        }

        // Update overall metrics
        stageMetrics.chunksProcessed++;
        stageMetrics.totalBytes += chunkSize;
        stageMetrics.lastChunkAt = now;
        lastOutputTimestamp = now; // Track for input-side turn detection
        
        // Update turn metrics
        const currentTurn = stageMetrics.currentTurn!;
        currentTurn.chunksProcessed++;
        currentTurn.totalBytes += chunkSize;
        currentTurn.lastChunkAt = now;

        // Track first chunk (overall and per-turn)
        if (stageMetrics.firstChunkAt === null) {
          stageMetrics.firstChunkAt = now;
        }
        
        const isFirstChunkOfTurn = currentTurn.firstChunkAt === null;
        if (isFirstChunkOfTurn) {
          currentTurn.firstChunkAt = now;
          const timeToFirstChunk = now - currentTurn.startedAt;
          currentTurn.ttfc = timeToFirstChunk;
          
          // Calculate input-to-output latency if we have input timestamp
          if (currentTurn.firstInputAt !== null) {
            currentTurn.inputToOutputLatency = now - currentTurn.firstInputAt;
          }
          
          // Clear processing state - we're now outputting
          isProcessing = false;
          if (visualizer) {
            visualizer.onFirstChunk(stageName, currentTurn.turnNumber, timeToFirstChunk, chunkPreview);
            
            // Send latency update
            visualizer.onLatencyUpdate({
              stageName,
              turnNumber: currentTurn.turnNumber,
              ttfc: currentTurn.ttfc,
              inputToOutput: currentTurn.inputToOutputLatency,
              interChunkAvg: stageMetrics.avgInterChunkLatency,
              stats: {
                min: stageMetrics.latencyStats.min,
                max: stageMetrics.latencyStats.max,
                avg: stageMetrics.latencyStats.avg,
                p50: stageMetrics.latencyStats.p50,
                p95: stageMetrics.latencyStats.p95,
                p99: stageMetrics.latencyStats.p99,
              },
            });
          } else {
            log(`[Pipeline] Stage "${stageName}" turn #${currentTurn.turnNumber} first chunk`, {
              timeToFirstChunkMs: timeToFirstChunk,
              inputToOutputMs: currentTurn.inputToOutputLatency,
              chunkSize,
              chunkPreview,
            });
          }
        }

        // Update visualizer with chunk data
        if (visualizer) {
          visualizer.onChunk(stageName, stageMetrics, chunkPreview);
        }

        if (options.verbose && !visualizer) {
          log(`[Pipeline] Stage "${stageName}" chunk #${stageMetrics.chunksProcessed} (turn #${currentTurn.turnNumber})`, {
            chunkSize,
            totalBytes: stageMetrics.totalBytes,
            turnBytes: currentTurn.totalBytes,
            elapsedMs: now - stageMetrics.startedAt,
          });
        }

        options.onChunkProcessed?.(stageName, { ...stageMetrics });
        controller.enqueue(value);
      } catch (error) {
        log(`[Pipeline] Stage "${stageName}" error`, { error: String(error) });
        controller.error(error);
      }
    },
    cancel(reason) {
      log(`[Pipeline] Stage "${stageName}" cancelled`, { reason: String(reason) });
      reader.cancel(reason);
    },
  });

  const observableWritable = new WritableStream<I>({
    async write(chunk) {
      const startTime = Date.now();
      
      // Check if this is meaningful input worth visualizing
      // Skip binary audio data (continuous stream) and empty strings
      const isMeaningfulInput = isSignificantChunk(chunk);
      
      if (isMeaningfulInput) {
        const chunkPreview = getChunkPreview(chunk);
        const now = Date.now();
        
        // Check if this input is for a NEW turn (idle threshold passed since last output)
        const timeSinceLastOutput = lastOutputTimestamp > 0 ? now - lastOutputTimestamp : Infinity;
        const isNewTurnInput = timeSinceLastOutput > turnIdleThreshold;
        
        // Detect turn based on current state
        inputTurnNumber = stageMetrics.turns.length + (isNewTurnInput ? 1 : 0) + 1;
        
        // Track first input timestamp for input-to-output latency
        if (isNewTurnInput || !stageMetrics.currentTurn) {
          // This is input for a NEW turn - store as pending
          if (pendingInputTimestamp === null) {
            pendingInputTimestamp = now;
          }
        } else if (stageMetrics.currentTurn && stageMetrics.currentTurn.firstInputAt === null) {
          // Same turn, first input
          stageMetrics.currentTurn.firstInputAt = now;
        }
        
        // Notify visualizer of input
        if (visualizer) {
          visualizer.onInput(stageName, inputTurnNumber, chunkPreview);
          
          // If not already processing, mark as processing (waiting for output)
          if (!isProcessing) {
            isProcessing = true;
            visualizer.onProcessing(stageName, inputTurnNumber);
          }
        }
      }
      
      await writer.write(chunk);
      stageMetrics.processingTimeMs += Date.now() - startTime;
    },
    async close() {
      await writer.close();
    },
    async abort(reason) {
      await writer.abort(reason);
    },
  });

  return {
    readable: observableReadable,
    writable: observableWritable,
  };
}

/**
 * Check if a chunk is significant enough to visualize as input
 * Filters out binary audio data and empty strings
 */
function isSignificantChunk(chunk: unknown): boolean {
  // Binary data (audio) - skip visualization (it's continuous)
  if (chunk instanceof Buffer || chunk instanceof ArrayBuffer || chunk instanceof Uint8Array) {
    return false;
  }
  
  // Empty or whitespace-only strings
  if (typeof chunk === "string") {
    return chunk.trim().length > 0;
  }
  
  // Objects (like AIMessageChunk) - check if they have meaningful content
  if (typeof chunk === "object" && chunk !== null) {
    // Check for content property (common in LangChain messages)
    if ("content" in chunk) {
      const content = (chunk as { content: unknown }).content;
      if (typeof content === "string") {
        return content.trim().length > 0;
      }
    }
    // Other objects are considered significant
    return true;
  }
  
  return true;
}

/**
 * Get a preview of chunk content for logging (truncated for readability)
 */
function getChunkPreview(chunk: unknown, maxLength: number = 50): string {
  if (typeof chunk === "string") {
    return chunk.length > maxLength ? chunk.slice(0, maxLength) + "..." : chunk;
  }
  if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
    return `<binary ${chunk.length} bytes>`;
  }
  if (typeof chunk === "object" && chunk !== null) {
    const str = JSON.stringify(chunk);
    return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
  }
  return String(chunk);
}

/**
 * Get the size of a chunk in bytes
 */
function getChunkSize(chunk: unknown): number {
  if (chunk instanceof Buffer) {
    return chunk.length;
  }
  if (chunk instanceof ArrayBuffer) {
    return chunk.byteLength;
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, "utf-8");
  }
  if (typeof chunk === "object" && chunk !== null) {
    return JSON.stringify(chunk).length;
  }
  return 0;
}

/**
 * Extract a meaningful name from a transform object
 */
function getTransformName(transform: TransformStream<unknown, unknown>): string {
  const constructor = transform.constructor;
  if (constructor && constructor.name && constructor.name !== "TransformStream") {
    return constructor.name;
  }
  return "AnonymousTransform";
}

/**
 * LangChainAudioReadableStream - A ReadableStream with built-in observability
 * 
 * @example
 * ```ts
 * const pipeline = new LangChainAudioReadableStream(inputStream, {
 *   verbose: true,
 *   onPipelineComplete: (metrics) => {
 *     console.log("Pipeline complete!", metrics);
 *   }
 * })
 *   .pipeThrough(new AssemblyAISTTTransform({ ... }))
 *   .pipeThrough(new AgentTransform(agent))
 *   .pipeThrough(new AIMessageChunkTransform())
 *   .pipeThrough(new HumeTTSTransform({ ... }));
 * ```
 */
export class LangChainAudioReadableStream<T> extends ReadableStream<T> {
  private _metrics: Map<string, StageMetrics> = new Map();
  private _options: InternalOptions;
  private _stageIndex: number = 0;
  private _pipelineStartedAt: number;
  private _visualizer?: PipelineVisualizer;

  constructor(
    underlyingSource?: UnderlyingSource<T> | ReadableStream<T>,
    options: ObservabilityOptions = {}
  ) {
    if (underlyingSource instanceof ReadableStream) {
      // Wrap an existing ReadableStream
      const reader = underlyingSource.getReader();
      super({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        },
        cancel(reason) {
          reader.cancel(reason);
        },
      });
    } else {
      super(underlyingSource);
    }

    // Use visualizer if provided
    if (options.visualizer) {
      this._visualizer = options.visualizer;
    }
    
    this._options = {
      ...options,
      _visualizer: this._visualizer,
    };
    this._pipelineStartedAt = Date.now();
    
    // Only log if not using visualizer
    if (!this._visualizer) {
      const log = options.logger ?? console.log;
      log("[Pipeline] Stream initialized", { timestamp: new Date().toISOString() });
    }
  }

  /**
   * Pipe through a transform with observability
   */
  pipeThrough<O>(
    transform: TransformStream<T, O>,
    options?: StreamPipeOptions & { stageName?: string }
  ): LangChainAudioReadableStream<O> {
    this._stageIndex++;
    const stageName = options?.stageName ?? `${this._stageIndex}. ${getTransformName(transform)}`;
    
    const observableTransform = createObservableTransform(
      transform,
      stageName,
      this._metrics,
      this._options
    );

    // Use native pipeThrough
    const resultStream = super.pipeThrough(observableTransform, options);

    // Wrap result in a new LangChainAudioReadableStream to maintain chainability
    // Pass the existing visualizer to avoid creating a new one
    const wrappedStream = new LangChainAudioReadableStream<O>(resultStream, {
      ...this._options,
      visualizer: this._visualizer,
    });
    wrappedStream._metrics = this._metrics;
    wrappedStream._stageIndex = this._stageIndex;
    wrappedStream._pipelineStartedAt = this._pipelineStartedAt;
    wrappedStream._visualizer = this._visualizer;

    return wrappedStream;
  }
}

export type { StageMetrics, TurnMetrics, LatencyStats, LatencyData, ObservabilityOptions };

