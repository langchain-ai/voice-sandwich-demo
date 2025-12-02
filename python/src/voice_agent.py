from typing import Any, Awaitable, Callable
import asyncio

from dotenv import load_dotenv
from typing_extensions import AsyncIterator
from langchain_core.runnables import RunnableGenerator, Runnable
from langchain.agents import create_agent
from langchain.messages import AIMessage
import pyaudio

from assemblyai_stt import microphone_and_transcribe_once
from elevenlabs_tts import text_to_speech_stream

load_dotenv()


def get_weather(location: str) -> str:
    """Get the weather at a location."""
    return f"The weather in {location} is sunny with a high of 75°F."


agent = create_agent(
    model="anthropic:claude-haiku-4-5",
    tools=[get_weather],
    system_prompt=(
        "You are a helpful assistant. Target concise responses under 50 words."
    ),
)


async def _play_tts_from_text(text: str) -> None:
    """Stream ElevenLabs audio until completion."""
    stripped = text.strip()
    if not stripped:
        print("[DEBUG] _play_tts_from_text: Empty response, skipping TTS")
        return

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

    try:
        async for audio_chunk in audio_generator:
            await loop.run_in_executor(None, audio_stream.write, audio_chunk)
        print("[DEBUG] _play_tts_from_text: Playback complete")
    finally:
        audio_stream.stop_stream()
        audio_stream.close()
        p.terminate()


TranscribeFn = Callable[[int], Awaitable[str]]
TTSFn = Callable[[str], Awaitable[None]]


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
        transcribe_fn: TranscribeFn = microphone_and_transcribe_once,
        tts_fn: TTSFn = _play_tts_from_text,
    ) -> None:
        self.agent = agent_runnable
        self.transcribe_fn = transcribe_fn
        self.tts_fn = tts_fn
        self.turn_number = 0

        self.audio_stream = (
            RunnableGenerator(self._transcribe_stream)
            | RunnableGenerator(self._agent_stream)
            | RunnableGenerator(self._tts_stream)
        )

    async def _transcribe_stream(
        self, sentinel_stream: AsyncIterator[Any]
    ) -> AsyncIterator[dict[str, Any]]:
        """
        Capture a single conversational turn from the microphone/STT layer.
        """
        async for _ in sentinel_stream:
            self.turn_number += 1
            turn = self.turn_number
            try:
                transcript = await self.transcribe_fn(turn)
            except Exception as exc:  # pragma: no cover - defensive logging
                print(f"[DEBUG] STT error: {exc}")
                continue

            if not transcript:
                print("[DEBUG] _transcribe_stream: Empty transcript, skipping turn")
                continue

            yield {"turn": turn, "transcript": transcript}

    async def _agent_stream(
        self, transcript_stream: AsyncIterator[dict[str, Any]]
    ) -> AsyncIterator[dict[str, Any]]:
        """
        Pass transcripts to the LangChain agent and emit full responses.
        """
        async for payload in transcript_stream:
            transcript = payload["transcript"]
            turn = payload["turn"]

            print(f"\n[User {turn}]: {transcript}")
            print("[Agent]: ", end="", flush=True)

            agent_response_chunks: list[str] = []
            input_message = {"role": "user", "content": transcript}

            async for message, _ in self.agent.astream(
                {"messages": [input_message]},
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

    async def _tts_stream(
        self, response_stream: AsyncIterator[dict[str, Any]]
    ) -> AsyncIterator[dict[str, Any]]:
        """
        Convert agent text responses to speech sequentially.
        """
        async for payload in response_stream:
            response_text = payload["response_text"]
            turn = payload["turn"]

            await self.tts_fn(response_text)
            yield {"turn": turn, "status": "tts_complete"}

    async def run(self) -> None:
        """Drive the LCEL pipeline turn by turn."""

        try:
            while True:
                async def sentinel_driver() -> AsyncIterator[None]:
                    yield None

                async for output in self.audio_stream.astream(sentinel_driver()):
                    print(f"[DEBUG] VoicePipeline.run: pipeline output {output}")
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # pragma: no cover - defensive logging
            print(f"[DEBUG] VoicePipeline.run: pipeline error: {exc}")
            print(f"[DEBUG] VoicePipeline.run: pipeline output {output}")
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # pragma: no cover - defensive logging
            print(f"[DEBUG] VoicePipeline.run: pipeline error: {exc}")


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

    try:
        await voice_pipeline.run()
    except KeyboardInterrupt:
        print("\n\nStopping pipeline...")
    except Exception as e:
        print(f"[DEBUG] main: Error occurred: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
