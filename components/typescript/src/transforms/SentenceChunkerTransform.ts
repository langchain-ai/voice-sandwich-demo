export class SentenceChunkTransform extends TransformStream<string, string> {
  constructor(wordThreshold: number = 5) {
    let buffer = "";

    super({
      transform(chunk, controller) {
        buffer += chunk;

        let madeProgress = true;
        while (madeProgress && buffer.length > 0) {
          madeProgress = false;

          // 1. Check for sentence boundaries
          const sentenceMatch = /[.!?](\s|$)/.exec(buffer);
          if (sentenceMatch) {
            const splitIndex = sentenceMatch.index + 1;
            const text = buffer.slice(0, splitIndex).trim();
            if (text) controller.enqueue(text);

            buffer = buffer.slice(splitIndex);
            madeProgress = true;
            continue;
          }

          // 2. Check for word count (Approx 5 words)
          // Regex looks for 5 groups of non-whitespace chars followed by optional whitespace
          // but ensures we capture the trailing space to split correctly
          const wordRegex = new RegExp(`^(\\s*\\S+){${wordThreshold}}`);
          const match = wordRegex.exec(buffer);

          if (match) {
            const chunkText = match[0];
            controller.enqueue(chunkText.trim());
            buffer = buffer.slice(chunkText.length);
            madeProgress = true;
          }
        }
      },
      flush(controller) {
        if (buffer.trim().length > 0) {
          controller.enqueue(buffer.trim());
        }
      },
    });
  }
}
