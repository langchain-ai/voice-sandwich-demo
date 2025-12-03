import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

const FFMPEG = ffmpegPath || "ffmpeg";

export class OpusToPcmTransform extends TransformStream<Buffer, Buffer> {
  constructor() {
    const ffmpeg = spawn(FFMPEG, [
      "-i",
      "pipe:0",
      "-f",
      "webm",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ]);

    ffmpeg.on("error", (err) => console.error("FFmpeg error:", err));
    // Consume stderr to prevent blocking
    ffmpeg.stderr.on("data", () => {});

    super({
      start(controller) {
        ffmpeg.stdout.on("data", (chunk: Buffer) => {
          controller.enqueue(chunk);
        });
        ffmpeg.stdout.on("error", (err) => {
          console.error("FFmpeg stdout error", err);
          controller.error(err);
        });
      },
      transform(chunk) {
        try {
          if (!ffmpeg.stdin.destroyed) {
            ffmpeg.stdin.write(chunk);
          }
        } catch {
          // Ignore write errors if ffmpeg died
        }
      },
      flush() {
        if (!ffmpeg.stdin.destroyed) {
          ffmpeg.stdin.end();
        }
      },
    });
  }
}
