/**
 * ThinkingFillerTransform
 *
 * A TransformStream that emits "filler" phrases (e.g., "Let me see...", "Hmm, one moment...")
 * when the upstream agent takes longer than a specified threshold to respond.
 * This creates a more natural, conversational experience for voice applications.
 *
 * Input: string (text from AIMessageChunkTransform)
 * Output: string (original text + optional filler phrases)
 */

export interface ThinkingFillerOptions {
  /**
   * Time in milliseconds before emitting a filler phrase.
   * @default 1000
   */
  thresholdMs?: number;

  /**
   * Array of filler phrases to randomly choose from.
   * @default ["Let me see here...", "Hmm, one moment...", "Ah, let me think..."]
   */
  fillerPhrases?: string[];

  /**
   * Whether the filler functionality is enabled.
   * @default true
   */
  enabled?: boolean;

  /**
   * Maximum number of fillers to emit per turn (before real response arrives).
   * @default 1
   */
  maxFillersPerTurn?: number;

  /**
   * Delay in milliseconds between consecutive filler phrases if maxFillersPerTurn > 1.
   * @default 2000
   */
  fillerIntervalMs?: number;

  /**
   * Callback when a filler phrase is emitted.
   */
  onFillerEmitted?: (phrase: string) => void;
}

interface ThinkingFillerState {
  controller: TransformStreamDefaultController<string> | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
  intervalId: ReturnType<typeof setInterval> | null;
  fillersEmittedThisTurn: number;
  hasReceivedResponse: boolean;
}

export class ThinkingFillerTransform extends TransformStream<string, string> {
  readonly #thresholdMs: number;
  readonly #fillerPhrases: string[];
  readonly #enabled: boolean;
  readonly #maxFillersPerTurn: number;
  readonly #fillerIntervalMs: number;
  readonly #onFillerEmitted?: (phrase: string) => void;
  readonly #state: ThinkingFillerState;

  constructor(options: ThinkingFillerOptions = {}) {
    const {
      thresholdMs = 1000,
      fillerPhrases = [
        "Let me see here...",
        "Hmm, one moment...",
        "Ah, let me think...",
        "Just a second...",
        "Mhm, okay...",
      ],
      enabled = true,
      maxFillersPerTurn = 1,
      fillerIntervalMs = 2000,
      onFillerEmitted,
    } = options;

    // Create state object before super() - shared between transformer and class methods
    const state: ThinkingFillerState = {
      controller: null,
      timeoutId: null,
      intervalId: null,
      fillersEmittedThisTurn: 0,
      hasReceivedResponse: false,
    };

    const clearTimers = () => {
      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
      if (state.intervalId) {
        clearInterval(state.intervalId);
        state.intervalId = null;
      }
    };

    super({
      start(controller) {
        state.controller = controller;
      },

      transform(chunk, controller) {
        // Real text arrived - cancel any pending filler timers
        clearTimers();
        state.hasReceivedResponse = true;

        // Pass through the actual response
        controller.enqueue(chunk);
      },

      flush() {
        // Clean up any timers on stream close
        clearTimers();
      },
    });

    this.#state = state;
    this.#thresholdMs = thresholdMs;
    this.#fillerPhrases = fillerPhrases;
    this.#enabled = enabled;
    this.#maxFillersPerTurn = maxFillersPerTurn;
    this.#fillerIntervalMs = fillerIntervalMs;
    this.#onFillerEmitted = onFillerEmitted;
  }

  /**
   * Call this method when the agent starts processing a user request.
   * This starts the filler timer.
   */
  notifyProcessingStarted(): void {
    if (!this.#enabled) return;

    // Reset state for new turn
    this.#state.fillersEmittedThisTurn = 0;
    this.#state.hasReceivedResponse = false;

    // Clear any existing timers
    this.#clearTimers();

    // Start the filler timer
    this.#state.timeoutId = setTimeout(() => {
      this.#emitFiller();

      // If we can emit more fillers, set up interval
      if (this.#maxFillersPerTurn > 1) {
        this.#state.intervalId = setInterval(() => {
          if (
            this.#state.fillersEmittedThisTurn < this.#maxFillersPerTurn &&
            !this.#state.hasReceivedResponse
          ) {
            this.#emitFiller();
          } else {
            this.#clearTimers();
          }
        }, this.#fillerIntervalMs);
      }
    }, this.#thresholdMs);
  }

  /**
   * Call this method to cancel any pending filler.
   * Useful when the user interrupts or the turn is cancelled.
   */
  cancelPendingFiller(): void {
    this.#clearTimers();
  }

  #clearTimers(): void {
    if (this.#state.timeoutId) {
      clearTimeout(this.#state.timeoutId);
      this.#state.timeoutId = null;
    }
    if (this.#state.intervalId) {
      clearInterval(this.#state.intervalId);
      this.#state.intervalId = null;
    }
  }

  #emitFiller(): void {
    if (
      !this.#state.controller ||
      this.#state.hasReceivedResponse ||
      this.#state.fillersEmittedThisTurn >= this.#maxFillersPerTurn
    ) {
      return;
    }

    // Pick a random filler phrase
    const phrase =
      this.#fillerPhrases[
        Math.floor(Math.random() * this.#fillerPhrases.length)
      ];

    console.log(`[ThinkingFiller] Emitting filler: "${phrase}"`);

    // Emit the filler phrase
    this.#state.controller.enqueue(phrase);
    this.#state.fillersEmittedThisTurn++;

    // Call the callback if provided
    this.#onFillerEmitted?.(phrase);
  }
}

