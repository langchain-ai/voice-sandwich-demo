from typing import Any

from dotenv import load_dotenv
from typing_extensions import AsyncIterator
from langchain_core.runnables import RunnableGenerator
from langchain_core.messages import AIMessage
from langchain.agents import create_agent

load_dotenv()

# Combined microphone + transcription node
# Captures audio and transcribes until AssemblyAI returns a final transcript
# Loops continuously for multi-turn conversation
async def _microphone_and_transcribe(input: AsyncIterator[Any]) -> AsyncIterator[str]:
    """
    Capture audio from microphone and transcribe with AssemblyAI.
    Stops microphone when AssemblyAI sends a final transcript, then restarts for next turn.

    Yields:
        Final transcribed text strings (one per turn)
    """
    import asyncio
    import pyaudio
    from assemblyai_stt import AssemblyAISTTTransform

    print("[DEBUG] _microphone_and_transcribe: Starting combined mic + transcription")

    # Initialize microphone once
    p = pyaudio.PyAudio()
    stream = p.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=16000,
        input=True,
        frames_per_buffer=1600
    )
    print("[DEBUG] Microphone opened")

    try:
        # Loop for continuous conversation turns
        turn_number = 0
        while True:
            turn_number += 1
            print(f"\n[DEBUG] === Turn {turn_number}: Listening... ===")

            stop_event = asyncio.Event()

            # Initialize AssemblyAI for this turn
            stt = AssemblyAISTTTransform(sample_rate=16000)
            await stt.connect()

            # Background task to capture and send audio
            async def capture_and_send():
                chunk_count = 0
                try:
                    while not stop_event.is_set():
                        audio_data = await asyncio.get_event_loop().run_in_executor(
                            None, stream.read, 1600, False
                        )
                        await stt.send_audio(audio_data)
                        chunk_count += 1
                        if chunk_count % 50 == 0:
                            print(f"[DEBUG] Captured {chunk_count} audio chunks")
                except Exception as e:
                    print(f"[DEBUG] Audio capture stopped: {e}")
                finally:
                    print(f"[DEBUG] Total audio chunks captured: {chunk_count}")

            send_task = asyncio.create_task(capture_and_send())

            # Listen for final transcript from AssemblyAI
            transcripts = []
            async for transcript in stt._receive_messages():
                print(f"[DEBUG] Received transcript: {transcript}")
                transcripts.append(transcript)
                # Stop microphone after first final transcript
                stop_event.set()
                break

            # Wait for send task to finish
            await send_task

            # Terminate AssemblyAI session for this turn
            await stt.terminate()
            await stt.close()

            # Yield the final transcript
            if transcripts:
                final_transcription = " ".join(transcripts)
                print(f"[DEBUG] Yielding final: {final_transcription}")
                yield final_transcription

            # Brief pause before next turn
            await asyncio.sleep(0.1)

    except KeyboardInterrupt:
        print("\n[DEBUG] Stopping conversation...")
    finally:
        # Clean up microphone
        if stream:
            stream.stop_stream()
            stream.close()
        p.terminate()
        print("[DEBUG] Microphone closed")


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


# this is where we would call openai/11labs/etc. to generate text to speech
async def _tts_stream(input: str) -> AsyncIterator[str]:
    print(f"[DEBUG] _tts_stream: Got input: {input}")
    yield "hello"


audio_stream = (
    RunnableGenerator(_microphone_and_transcribe)  # Combined mic + transcription
    | RunnableGenerator(_stream_agent)
    | RunnableGenerator(_tts_stream)
)


async def main():
    """
    Voice pipeline: Microphone → AssemblyAI STT → Agent → TTS
    """
    print("Starting voice pipeline...")
    print("Speak into your microphone. Press Ctrl+C to stop.\n")

    try:
        print("[DEBUG] main: Starting audio_stream.astream(None)")
        async for output in audio_stream.astream(None):
            print(f"[DEBUG] main: Final output: {output}")
    except KeyboardInterrupt:
        print("\n\nStopping pipeline...")
    except Exception as e:
        print(f"[DEBUG] main: Error occurred: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
