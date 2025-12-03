import { RunTree } from "langsmith";
import type { RunTreeConfig } from "langsmith/run_trees";
import { traceable } from "langsmith/traceable";

export interface TracedTransformStreamOptions {
  name?: string;
  runType?: RunTreeConfig["run_type"];
  metadata?: Record<string, any>;
}

/**
 * A TransformStream that traces its execution using LangSmith RunTree.
 * It can wrap either a simple Transformer object or another ReadableWritablePair (Stream).
 */
export class TracedTransformStream<I = any, O = any> extends TransformStream<
  I,
  O
> {
  public readonly options: TracedTransformStreamOptions;
  private parentRun?: RunTree;

  constructor(
    transformerOrStream: Transformer<I, O> | ReadableWritablePair<O, I>,
    options: TracedTransformStreamOptions = {}
  ) {
    const { name = "TracedTransform", runType = "chain", metadata } = options;
    const isStream =
      "readable" in transformerOrStream && "writable" in transformerOrStream;

    const wrappedTransformer: Transformer<I, O> = isStream
      ? TracedTransformStream.createStreamTransformer(
          transformerOrStream as ReadableWritablePair<O, I>,
          () => this.parentRun,
          transformerOrStream.constructor.name ?? name,
          runType,
          metadata
        )
      : TracedTransformStream.createProxyTransformer(
          transformerOrStream as Transformer<I, O>,
          () => this.parentRun,
          transformerOrStream.constructor.name ?? name,
          runType,
          metadata
        );

    super(wrappedTransformer);
    this.options = options;
  }

  setParentRun(run: RunTree) {
    this.parentRun = run;
  }

  private static createStreamTransformer<I, O>(
    stream: ReadableWritablePair<O, I>,
    getParentRun: () => RunTree | undefined,
    name: string,
    runType: RunTreeConfig["run_type"],
    metadata?: Record<string, any>
  ): Transformer<I, O> {
    return {
      start: (controller) => {
        stream.readable
          .pipeTo(
            new WritableStream({
              write(chunk) {
                controller.enqueue(chunk);
              },
              close() {
                controller.terminate();
              },
              abort(reason) {
                controller.error(reason);
              },
            })
          )
          .catch((e) => controller.error(e));
      },
      transform: async (chunk) => {
        const parentRun = getParentRun();

        try {
          const writer = stream.writable.getWriter();

          // We wrap the write in a traceable function to show it as a discrete step
          const writeToStream = traceable(
            async (c: I) => {
              await writer.write(c);
            },
            {
              name,
              run_type: runType,
              parent_run: parentRun,
              metadata,
            }
          );

          // this is sort of obscure, but immediately executed traceable expressions
          // don't immediately set ALS context for stacks that get executed through
          // node internals (e.g. when calling controller.enqueue). Awaiting a timeout
          // call forces a microtask to be scheduled, which gives the runtime a chance to
          // set the ALS context for the current call stack.
          void (await setTimeout(() => {}, 0));

          // @ts-expect-error - weird traceable typing
          await writeToStream(chunk);

          writer.releaseLock();

          await parentRun?.end({ status: "dispatched" });
          await parentRun?.patchRun();
        } catch (err) {
          await parentRun?.end(
            undefined,
            err instanceof Error ? err.message : String(err)
          );
          await parentRun?.patchRun();
          throw err;
        }
      },
      flush: async () => {
        const writer = stream.writable.getWriter();
        await writer.close();
        writer.releaseLock();
      },
    };
  }

  // TODO: implement
  private static createProxyTransformer<I, O>(
    _transformer: Transformer<I, O>,
    _getParentRun: () => RunTree | undefined,
    _name: string,
    _runType: RunTreeConfig["run_type"],
    _metadata?: Record<string, any>
  ): Transformer<I, O> {
    void _transformer;
    void _getParentRun;
    void _name;
    void _runType;
    void _metadata;
    // no-op
    return {} as Transformer<I, O>;
  }
}

/**
 * A wrapper around ReadableStream that allows tracing a pipeline of transforms.
 */
export class TracedReadableStream<R = any> implements ReadableStreamLike<R> {
  private innerStream: ReadableStream<R>;
  private pipelineRun: RunTree;
  private isTraceEnded = false;

  get locked() {
    return this.innerStream.locked;
  }

  constructor(
    underlyingSource?: UnderlyingSource<R> | ReadableStream<R>,
    strategy?: QueuingStrategy<R>
  ) {
    if (underlyingSource instanceof ReadableStream) {
      this.innerStream = underlyingSource;
    } else {
      this.innerStream = new ReadableStream(underlyingSource, strategy);
    }

    this.pipelineRun = new RunTree({
      name: this.constructor.name,
      run_type: "chain",
      inputs: {},
    });

    // Initialize the root run
    this.pipelineRun.postRun().catch(console.error);
  }

  static from<R>(stream: ReadableStream<R>): TracedReadableStream<R> {
    return new TracedReadableStream(stream);
  }

  // Internal method to chain streams while preserving the run
  private static fromStreamAndRun<R>(
    stream: ReadableStream<R>,
    run: RunTree
  ): TracedReadableStream<R> {
    // We bypass the standard constructor logic for chained streams
    const tracedStream = Object.create(TracedReadableStream.prototype);
    tracedStream.innerStream = stream;
    tracedStream.pipelineRun = run;
    tracedStream.isTraceEnded = false;
    return tracedStream as TracedReadableStream<R>;
  }

  private async endTrace(outputs?: any, error?: string) {
    if (this.isTraceEnded) return;
    this.isTraceEnded = true;
    // If we are ending successfully without outputs, we can default to something or empty
    await this.pipelineRun.end(outputs, error);
    await this.pipelineRun.patchRun();
  }

  async cancel(reason?: any): Promise<void> {
    try {
      await this.innerStream.cancel(reason);
      await this.endTrace(undefined, reason ? String(reason) : "Cancelled");
    } catch (err) {
      await this.endTrace(undefined, String(err));
      throw err;
    }
  }

  getReader(options?: { mode: undefined }): ReadableStreamDefaultReader<R>;
  getReader(options?: { mode: "byob" }): ReadableStreamBYOBReader;
  getReader(options?: any): any {
    const reader = this.innerStream.getReader(options);

    // We intercept the reader methods to detect end of stream
    return new Proxy(reader, {
      get: (target, prop, receiver) => {
        if (prop === "read") {
          return async (...args: any[]) => {
            try {
              // @ts-expect-error - proxy typing
              const result = await target.read(...args);
              if (result.done) {
                await this.endTrace({ status: "completed" });
              }
              return result;
            } catch (err) {
              await this.endTrace(undefined, String(err));
              throw err;
            }
          };
        }
        if (prop === "cancel") {
          return async (reason?: any) => {
            try {
              await target.cancel(reason);
              await this.endTrace(
                undefined,
                reason ? String(reason) : "Cancelled"
              );
            } catch (err) {
              await this.endTrace(undefined, String(err));
              throw err;
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  async pipeTo(
    destination: WritableStream<R>,
    options?: StreamPipeOptions
  ): Promise<void> {
    try {
      await this.innerStream.pipeTo(destination, options);
      await this.endTrace({ status: "completed" });
    } catch (err) {
      await this.endTrace(undefined, String(err));
      throw err;
    }
  }

  pipeThrough<T>(
    transform: ReadableWritablePair<T, R> | TracedTransformStream<R, T>,
    options?: StreamPipeOptions
  ): TracedReadableStream<T> {
    if (transform instanceof TracedTransformStream) {
      // Use the provided instance
      const tracedWrapper = transform as TracedTransformStream<R, T>;
      tracedWrapper.setParentRun(this.pipelineRun);
      const nextStream = this.innerStream.pipeThrough(tracedWrapper, options);
      return TracedReadableStream.fromStreamAndRun(
        nextStream,
        this.pipelineRun
      );
    }

    // If not a TracedTransformStream, just pipe through normally
    // We still wrap the result in TracedReadableStream to preserve the pipeline run
    // for future steps
    const nextStream = this.innerStream.pipeThrough(transform, options);
    return TracedReadableStream.fromStreamAndRun(nextStream, this.pipelineRun);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<R> {
    // We need to ensure we use our wrapped getReader so tracing works
    const reader = this.getReader();
    return {
      next: async () => {
        const { done, value } = await reader.read();
        return { done, value } as IteratorResult<R>;
      },
      return: async () => {
        await reader.cancel();
        return { done: true, value: undefined } as IteratorResult<R>;
      },
      throw: async (e: any) => {
        await reader.cancel(e);
        return { done: true, value: undefined } as IteratorResult<R>;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

// Minimal interface
interface ReadableStreamLike<R> {
  cancel(reason?: any): Promise<void>;
  pipeThrough<T>(
    transform: ReadableWritablePair<T, R>,
    options?: StreamPipeOptions
  ): any;
  pipeTo(
    destination: WritableStream<R>,
    options?: StreamPipeOptions
  ): Promise<void>;
  getReader(options?: any): any;
}
