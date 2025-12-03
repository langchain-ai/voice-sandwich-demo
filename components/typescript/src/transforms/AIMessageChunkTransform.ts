import type { AIMessageChunk } from "@langchain/core/messages";

export class AIMessageChunkTransform extends TransformStream<
  AIMessageChunk,
  string
> {
  constructor() {
    super({
      transform(chunk, controller) {
        controller.enqueue(chunk.text);
      },
    });
  }
}
