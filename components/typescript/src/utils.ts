/**
 * Immediately Invoked Function Expression (IIFE) helper.
 */
export const iife = <T>(fn: () => T) => fn();

/**
 * A writable async iterator that allows pushing values and cancellation.
 *
 * Extends AsyncIterableIterator with methods to push values into the stream
 * and cancel the iteration. This is useful for bridging imperative push-based
 * APIs with async iteration patterns.
 *
 * @template T - The type of values yielded by the iterator
 */
export type WritableIterator<T> = AsyncIterableIterator<T> & {
  /**
   * Pushes a value into the iterator stream.
   *
   * The value will be yielded on the next iteration. If a consumer is currently
   * waiting for a value, it will be resolved immediately.
   *
   * @param {T} value - The value to push into the stream
   */
  push(value: T): void;

  /**
   * Cancels the iterator and signals completion.
   *
   * After calling cancel, the iterator will complete on the next iteration.
   * Any pending consumers will receive a done signal.
   */
  cancel(): void;
};

/**
 * Creates a writable async iterator that can be pushed to imperatively.
 *
 * This function creates an async iterator that bridges imperative push-based
 * code with async iteration patterns. Values can be pushed into the iterator
 * using the `push()` method, and consumers can iterate over them using
 * `for await...of` loops.
 *
 * The iterator maintains an internal queue of values. When a consumer requests
 * the next value:
 * - If values are queued, the next value is returned immediately
 * - If the queue is empty, the consumer waits until a value is pushed
 *
 * @template T - The type of values that will be pushed and yielded
 * @returns {WritableIterator<T>} A writable async iterator
 *
 * @example
 * ```typescript
 * const stream = writableIterator<string>();
 *
 * // Producer side
 * setTimeout(() => stream.push("hello"), 100);
 * setTimeout(() => stream.push("world"), 200);
 * setTimeout(() => stream.cancel(), 300);
 *
 * // Consumer side
 * for await (const value of stream) {
 *   console.log(value); // Logs: "hello", then "world"
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Common pattern: bridging WebSocket messages to async iteration
 * const messageStream = writableIterator<string>();
 *
 * ws.on('message', (data) => messageStream.push(data));
 * ws.on('close', () => messageStream.cancel());
 *
 * for await (const message of messageStream) {
 *   processMessage(message);
 * }
 * ```
 */
export function writableIterator<T>(): WritableIterator<T> {
  const deferred: IteratorResult<T>[] = [];
  let signalResolver: ((value: void) => void) | null = null;

  const stream: WritableIterator<T> = {
    push(value: T) {
      deferred.push({ value, done: false });
      if (signalResolver) {
        signalResolver();
        signalResolver = null;
      }
    },
    cancel() {
      deferred.push({ value: undefined, done: true });
      if (signalResolver) {
        signalResolver();
        signalResolver = null;
      }
    },
    async next(): Promise<IteratorResult<T>> {
      while (true) {
        if (deferred.length > 0) {
          return deferred.shift()!;
        } else {
          await new Promise<void>((resolve) => {
            signalResolver = resolve;
          });
        }
      }
    },
    async return(): Promise<IteratorResult<T>> {
      return { value: undefined, done: true };
    },
    async throw(e): Promise<IteratorResult<T>> {
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return stream;
}
