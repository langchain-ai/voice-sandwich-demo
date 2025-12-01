from typing import Any
import asyncio

from dotenv import load_dotenv
from typing_extensions import AsyncIterator
from langchain_core.runnables import RunnableGenerator
from langchain_core.messages import AIMessage
from langchain.agents import create_agent
import pyaudio

from assemblyai_stt import microphone_and_transcribe_once
from elevenlabs_tts import text_to_speech_stream

load_dotenv()


agent = create_agent(
    model="anthropic:claude-haiku-4-5",
    tools=[],
)


async def _stream_agent(
    input: AsyncIterator[tuple[AIMessage, Any]]
) -> AsyncIterator[str]:
    print("[DEBUG] _stream_agent: Starting agent stream")
    async for chunk in input:
        print(f"[DEBUG] _stream_agent: Received chunk: {chunk}")
        input_message = {"role": "user", "content": chunk}
        print(f"[DEBUG] _stream_agent: Sending to agent: {input_message}")
        async for message, _ in agent.astream({"messages": [input_message]}, stream_mode="messages"):
            print(f"[DEBUG] _stream_agent: Agent response: {message.text}")
            yield message.text


# ElevenLabs TTS - synthesize and play audio
async def _tts_stream(input: AsyncIterator[str]) -> AsyncIterator[str]:
    """
    Convert text to speech using ElevenLabs and play through speakers.

    Args:
        input: AsyncIterator of text strings from agent

    Yields:
        Status messages (for pipeline continuity)
    """
    print("[DEBUG] _tts_stream: Starting TTS")

    # Initialize audio output
    p = pyaudio.PyAudio()
    audio_stream = p.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=16000,
        output=True,
        frames_per_buffer=1600
    )
    print("[DEBUG] Audio output stream opened")

    try:
        # Synthesize and play audio
        async for audio_chunk in text_to_speech_stream(input):
            # Play audio chunk through speakers
            await asyncio.get_event_loop().run_in_executor(
                None, audio_stream.write, audio_chunk
            )

        print("[DEBUG] _tts_stream: Finished playing audio")
        yield "tts_complete"

    finally:
        # Clean up audio
        audio_stream.stop_stream()
        audio_stream.close()
        p.terminate()
        print("[DEBUG] Audio output closed")


async def main():
    """
    Voice pipeline: Microphone → AssemblyAI STT → Agent → TTS

    Loops continuously for multi-turn conversation.
    Each turn waits for TTS to complete before starting next mic capture.
    """
    print("Starting voice pipeline...")
    print("Speak into your microphone. Press Ctrl+C to stop.\n")

    turn_number = 0

    try:
        while True:
            turn_number += 1

            # 1. Capture and transcribe audio
            transcript = await microphone_and_transcribe_once(turn_number)
            if not transcript:
                continue

            print(f"\n[User]: {transcript}")

            # 2. Get agent response
            print("[Agent]: ", end="", flush=True)
            agent_response_chunks = []
            input_message = {"role": "user", "content": transcript}

            async for message, _ in agent.astream({"messages": [input_message]}, stream_mode="messages"):
                if hasattr(message, 'text') and message.text:
                    print(message.text, end="", flush=True)
                    agent_response_chunks.append(message.text)

            print()  # New line after agent response

            # 3. Convert agent response to speech and play
            if agent_response_chunks:
                # Join all chunks into single text
                full_text = "".join(agent_response_chunks)

                async def agent_text_stream():
                    yield full_text

                # Play TTS and wait for completion
                p = pyaudio.PyAudio()
                audio_stream = p.open(
                    format=pyaudio.paInt16,
                    channels=1,
                    rate=16000,
                    output=True,
                    frames_per_buffer=1600
                )

                try:
                    async for audio_chunk in text_to_speech_stream(agent_text_stream()):
                        await asyncio.get_event_loop().run_in_executor(
                            None, audio_stream.write, audio_chunk
                        )
                    print("[DEBUG] TTS playback complete")
                finally:
                    audio_stream.stop_stream()
                    audio_stream.close()
                    p.terminate()

            # TTS is now complete, safe to start next turn

    except KeyboardInterrupt:
        print("\n\nStopping pipeline...")
    except Exception as e:
        print(f"[DEBUG] main: Error occurred: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
