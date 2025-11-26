import { AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { type ReactAgent } from "langchain";

export interface AgentTransformOptions {
  /**
   * Callback fired when an interrupt occurs. The callback receives the
   * interrupt value (usually a message to speak to the user).
   */
  onInterrupt?: (value: unknown) => void;
}

interface StateTask {
  interrupts?: Array<{ value: unknown }>;
}

interface GraphState {
  tasks?: StateTask[];
}

/**
 * Input: User Text (String)
 * Output: AI Tokens (String) - Streamed
 *
 * Supports human-in-the-loop interrupts. When the agent calls `interrupt()`,
 * this transform will:
 * 1. Call the onInterrupt callback with the interrupt message
 * 2. Wait for the next user input
 * 3. Resume the graph with the user's response via Command
 */
export class AgentTransform {
  #pendingInterrupt: unknown | undefined = undefined;
  #graph: ReactAgent;
  #options: AgentTransformOptions;
  #threadId: string;
  #stream: TransformStream<string, AIMessageChunk>;

  constructor(graph: ReactAgent, options: AgentTransformOptions = {}) {
    this.#graph = graph;
    this.#options = options;
    this.#threadId = crypto.randomUUID();
    this.#stream = new TransformStream({
      transform: (text, controller) => this.#transform(text, controller),
    });
  }

  get readable(): ReadableStream<AIMessageChunk> {
    return this.#stream.readable;
  }

  get writable(): WritableStream<string> {
    return this.#stream.writable;
  }

  async #transform(text: string, controller: TransformStreamDefaultController<AIMessageChunk>) {
    let input: { messages: HumanMessage[] } | Command;

    // If there's a pending interrupt, resume with Command
    if (this.hasPendingInterrupt) {
      console.log(
        "[AgentTransform] Resuming from interrupt with user response:",
        text
      );
      input = new Command({ resume: text });
      this.#pendingInterrupt = undefined;
    } else {
      input = { messages: [new HumanMessage(text)] };
    }

    const graphStream = await this.#graph.stream(input, {
      configurable: { thread_id: this.#threadId },
      streamMode: "messages",
    });

    for await (const [chunk] of graphStream) {
      if (AIMessageChunk.isInstance(chunk)) {
        controller.enqueue(chunk);
      }
    }

    // Check the graph state for interrupts after streaming completes
    const state = (await this.#graph.getState({
      configurable: { thread_id: this.#threadId },
    })) as GraphState;

    if (state.tasks && state.tasks.length > 0) {
      for (const task of state.tasks) {
        if (task.interrupts && task.interrupts.length > 0) {
          const interruptValue = task.interrupts[0].value;
          console.log(
            "[AgentTransform] Interrupt detected:",
            interruptValue
          );
          this.#pendingInterrupt = interruptValue;

          if (this.#options.onInterrupt) {
            this.#options.onInterrupt(interruptValue);
          }

          // Emit the interrupt message as an AIMessageChunk so it goes through TTS
          const interruptChunk = new AIMessageChunk({
            content:
              typeof interruptValue === "string"
                ? interruptValue
                : String(interruptValue),
          });
          controller.enqueue(interruptChunk);
        }
      }
    }
  }

  get hasPendingInterrupt(): boolean {
    return typeof this.#pendingInterrupt !== "undefined";
  }
}
