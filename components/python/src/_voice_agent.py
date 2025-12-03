import asyncio
import base64
import contextlib
import io
import wave
from typing import Any, Awaitable, Callable, Optional

import pyaudio
from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.messages import AIMessage, HumanMessage
from langchain_core.runnables import Runnable, RunnableGenerator
from langgraph.checkpoint.memory import InMemorySaver
from typing_extensions import AsyncIterator

from assemblyai_stt import AssemblyAISTTTransform
from elevenlabs_tts import text_to_speech_stream

load_dotenv()


def _bytes_to_base64(data: bytes) -> str:
    """Encode bytes to a Base64 string (ASCII)."""
    return base64.b64encode(data).decode("ascii")


def _pcm16le_to_wav_bytes(
    audio_bytes: bytes,
    sample_rate: int = 16000,
    channels: int = 1,
) -> bytes:
    """Wrap raw PCM16LE audio in a WAV container."""
    if not audio_bytes:
        return b""

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)  # 16-bit samples
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio_bytes)
    return buffer.getvalue()


def get_weather(location: str) -> str:
    """Get the weather at a location."""
    return f"The weather in {location} is sunny with a high of 75°F."


checkpointer = InMemorySaver()
config = {"configurable": {"thread_id": "1"}}

agent = create_agent(
    model="anthropic:claude-haiku-4-5",
    tools=[get_weather],
    system_prompt=(
        "You are a helpful assistant. Target concise responses under 50 words."
    ),
    checkpointer=checkpointer,
)


async def _play_tts_from_text(text: str) -> bytes:
    """Stream ElevenLabs audio until completion and return the PCM bytes."""
    stripped = text.strip()
    if not stripped:
        print("[DEBUG] _play_tts_from_text: Empty response, skipping TTS")
        return b""

    async def agent_text_stream():
        yield stripped

    audio_generator = text_to_speech_stream(agent_text_stream())

    p = pyaudio.PyAudio()
    audio_stream = p.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=16000,
        output=True,
        frames_per_buffer=1600,
    )

    loop = asyncio.get_event_loop()
    captured_chunks: list[bytes] = []

    try:
        async for audio_chunk in audio_generator:
            captured_chunks.append(audio_chunk)
            await loop.run_in_executor(None, audio_stream.write, audio_chunk)
        print("[DEBUG] _play_tts_from_text: Playback complete")
    finally:
        audio_stream.stop_stream()
        audio_stream.close()
        p.terminate()

    return b"".join(captured_chunks)


TTSFn = Callable[[str], Awaitable[bytes]]
STTFactory = Callable[[], AssemblyAISTTTransform]
AudioStream = AsyncIterator[bytes]


async def microphone_audio_stream(
    chunk_size: int = 1600,
    sample_rate: int = 16000,
    channels: int = 1,
) -> AsyncIterator[bytes]:
    """Continuously yield raw PCM audio from the default microphone."""
    p = pyaudio.PyAudio()
    stream = p.open(
        format=pyaudio.paInt16,
        channels=channels,
        rate=sample_rate,
        input=True,
        frames_per_buffer=chunk_size,
    )

    loop = asyncio.get_event_loop()

    pending_future: asyncio.Future | None = None

    try:
        while True:
            pending_future = loop.run_in_executor(None, stream.read, chunk_size, False)
            try:
                audio_data = await pending_future
            except asyncio.CancelledError:
                pending_future.cancel()
                raise
            pending_future = None
            yield audio_data
    except (asyncio.CancelledError, GeneratorExit):
        pass
    finally:
        if pending_future is not None:
            pending_future.cancel()
        stream.stop_stream()
        stream.close()
        p.terminate()


async def _close_async_generator(gen: AudioStream) -> None:
    aclose = getattr(gen, "aclose", None)
    if aclose is not None:
        with contextlib.suppress(Exception):
            await aclose()


async def _shutdown_audio_stream(gen: AudioStream) -> None:
    await _close_async_generator(gen)


class VoicePipeline:
    """
    Demonstrates a plug-and-play LangChain LCEL pipeline:
    Microphone/STT → Agent → TTS.

    Each step is represented as a RunnableGenerator so alternative STT/TTS
    implementations can be swapped in without touching orchestration.
    """

    def __init__(
        self,
        agent_runnable: Runnable,
        tts_fn: TTSFn = _play_tts_from_text,
        stt_factory: Optional[STTFactory] = None,
        sample_rate: int = 16000,
    ) -> None:
        self.agent = agent_runnable
        self.tts_fn = tts_fn
        self.sample_rate = sample_rate
        self.stt_factory = stt_factory or (
            lambda: AssemblyAISTTTransform(sample_rate=self.sample_rate)
        )
        self.turn_number = 0

        self.buffer_runnable = RunnableGenerator(self.buffer)
        self.pipeline = (
            RunnableGenerator(self.transcribe)
            | RunnableGenerator(self.stream_agent)
            | RunnableGenerator(self.text_to_speech)
        )
        self.pipeline.name = "conversation_turn"
        self.run_runnable = RunnableGenerator(self.voice_run)

    async def buffer(self, audio_stream: AudioStream) -> AsyncIterator[HumanMessage]:
        """
        Buffer microphone audio, stream it to AssemblyAI, and emit turns.

        AssemblyAI's built-in VAD determines utterance boundaries. Whenever a
        formatted transcript arrives, the buffered PCM for that window is
        wrapped into a WAV audio block and yielded as a HumanMessage.
        """
        stt = self.stt_factory()
        await stt.connect()

        buffer_lock = asyncio.Lock()
        current_audio = bytearray()

        async def pump_audio() -> None:
            try:
                async for chunk in audio_stream:
                    if not chunk:
                        continue
                    async with buffer_lock:
                        current_audio.extend(chunk)
                    await stt.send_audio(chunk)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - defensive logging
                print(f"[DEBUG] pump_audio error: {exc}")
            finally:
                await stt.terminate()

        send_task = asyncio.create_task(pump_audio())

        try:
            async for transcript in stt._receive_messages():
                if not transcript:
                    continue

                async with buffer_lock:
                    turn_audio = bytes(current_audio)
                    current_audio.clear()

                if not turn_audio:
                    print("[DEBUG] buffer: Empty audio, skipping turn")
                    continue

                self.turn_number += 1
                turn = self.turn_number

                wav_bytes = _pcm16le_to_wav_bytes(
                    turn_audio, sample_rate=self.sample_rate
                )
                wav_base64 = _bytes_to_base64(wav_bytes)

                yield HumanMessage(
                    content_blocks=[
                        {
                            "type": "audio",
                            "base64": wav_base64,
                            "mime_type": "audio/wav",
                        },
                    ],
                    response_metadata={"turn": turn, "transcript": transcript},
                )
        except asyncio.CancelledError:
            print("[DEBUG] buffer: cancelled, stopping AssemblyAI stream")
            return
        finally:
            send_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await send_task
            await stt.close()

    async def transcribe(
        self, message_stream: AsyncIterator[HumanMessage]
    ) -> AsyncIterator[dict[str, Any]]:
        """Extract transcript metadata for downstream agent consumption."""
        async for message in message_stream:
            metadata = getattr(message, "response_metadata", {}) or {}
            transcript = metadata.get("transcript")
            turn = metadata.get("turn")
            if not transcript:
                print("[DEBUG] _transcribe_node: Missing transcript, skipping message")
                continue
            yield {"turn": turn, "transcript": transcript}

    async def stream_agent(
        self, transcript_stream: AsyncIterator[dict[str, Any]]
    ) -> AsyncIterator[dict[str, Any]]:
        """
        Pass transcripts to the LangChain agent and emit full responses.
        """
        async for payload in transcript_stream:
            transcript = payload["transcript"]
            turn = payload.get("turn")

            print(f"\n[User {turn}]: {transcript}")
            print("[Agent]: ", end="", flush=True)

            agent_response_chunks: list[str] = []
            input_message = {"role": "user", "content": transcript}

            async for message, _ in self.agent.astream(
                {"messages": [input_message]},
                config,
                stream_mode="messages",
            ):
                if isinstance(message, AIMessage) and message.text:
                    print(message.text, end="", flush=True)
                    agent_response_chunks.append(message.text)

            print()
            response_text = "".join(agent_response_chunks).strip()
            if not response_text:
                continue

            yield {"turn": turn, "response_text": response_text}

    async def text_to_speech(
        self, response_stream: AsyncIterator[dict[str, Any]]
    ) -> AsyncIterator[AIMessage]:
        """
        Convert agent text responses to speech sequentially and emit AI messages
        that include the synthesized audio as a WAV/base64 block.
        """
        async for payload in response_stream:
            response_text = payload["response_text"]
            turn = payload["turn"]

            pcm_bytes = await self.tts_fn(response_text)
            wav_bytes = _pcm16le_to_wav_bytes(pcm_bytes, sample_rate=self.sample_rate)
            wav_base64 = _bytes_to_base64(wav_bytes)

            yield AIMessage(
                content_blocks=[
                    {
                        "type": "audio",
                        "base64": wav_base64,
                        "mime_type": "audio/wav",
                    }
                ],
                response_metadata={
                    "turn": turn,
                    "response_text": response_text,
                },
            )

    async def voice_run(self, audio_stream: AudioStream) -> AsyncIterator[Any]:
        """Async generator that drives the LCEL pipeline turn by turn."""

        last_output: Any = None

        try:
            async for message in self.buffer_runnable.atransform(audio_stream):
                async for output in self.pipeline.astream(message):
                    last_output = output
                    metadata = output.response_metadata
                    print(f"[DEBUG] VoicePipeline.run: output {metadata}")
                    yield output
        except Exception as exc:  # pragma: no cover - defensive logging
            print(f"[DEBUG] VoicePipeline.run: pipeline error: {exc}")
            print(f"[DEBUG] VoicePipeline.run: last output {last_output}")
            raise

    async def run(self, audio_stream: AudioStream) -> None:
        """Compatibility wrapper that exhausts the run generator."""

        async for _ in self.run_runnable.atransform(audio_stream):
            pass


async def main():
    """
    Voice pipeline: Microphone → AssemblyAI STT → Agent → TTS

    Each stage is a RunnableGenerator so alternate implementations (web sockets,
    other vendors, etc.) can be swapped in while keeping the orchestration logic.
    This refactor focuses on clarity and modularity over overlapping turn
    handling—the agent response is fully spoken before the next turn begins.
    """
    print("Starting voice pipeline...")
    print("Speak into your microphone. Press Ctrl+C to stop.\n")

    voice_pipeline = VoicePipeline(agent)
    audio_stream = microphone_audio_stream(
        chunk_size=1600, sample_rate=voice_pipeline.sample_rate
    )

    try:
        async for _ in voice_pipeline.run_runnable.atransform(audio_stream):
            pass
    except KeyboardInterrupt:
        print("\n\nStopping pipeline...")
    except Exception as e:
        print(f"[DEBUG] main: Error occurred: {e}")
        import traceback

        traceback.print_exc()
    finally:
        await _shutdown_audio_stream(audio_stream)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
