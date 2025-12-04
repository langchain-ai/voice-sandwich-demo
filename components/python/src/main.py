import asyncio
import contextlib
from pathlib import Path
from typing import AsyncIterator
from uuid import uuid4

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from langchain.agents import create_agent
from langchain.messages import HumanMessage
from langchain_core.runnables import RunnableGenerator
from langgraph.checkpoint.memory import InMemorySaver

from assemblyai_stt import AssemblyAISTT
from elevenlabs_tts import ElevenLabsTTS

load_dotenv()

STATIC_DIR = Path(__file__).parent.parent / "static"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def add_to_order(item: str, quantity: int) -> str:
    """Add an item to the customer's sandwich order."""
    return f"Added {quantity} x {item} to the order."


def confirm_order(order_summary: str) -> str:
    """Confirm the final order with the customer."""
    return f"Order confirmed: {order_summary}. Sending to kitchen."


system_prompt = """
You are a helpful sandwich shop assistant. Your goal is to take the user's order.
Be concise and friendly. Do NOT use emojis, special characters, or markdown.
Your responses will be read by a text-to-speech engine.

Available toppings: lettuce, tomato, onion, pickles, mayo, mustard.
Available meats: turkey, ham, roast beef.
Available cheeses: swiss, cheddar, provolone.
"""

agent = create_agent(
    model="anthropic:claude-haiku-4-5",
    tools=[add_to_order, confirm_order],
    system_prompt=system_prompt,
    checkpointer=InMemorySaver(),
)


async def _stt_stream(audio_stream: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """
    Transform stream: Audio (Bytes) → Transcript (String)

    This function takes a stream of audio chunks and sends them to AssemblyAIfor STT.

    It uses a producer-consumer pattern where:
    - Producer: Reads audio chunks from audio_stream and sends them to AssemblyAI
    - Consumer: Receives transcription results from AssemblyAI and yields them

    Args:
        audio_stream: Async iterator of PCM audio bytes (16-bit, mono, 16kHz)

    Yields:
        Transcribed text strings from AssemblyAI (final transcripts only)
    """
    stt = AssemblyAISTT(sample_rate=16000)

    async def send_audio():
        """
        Background task that pumps audio chunks to AssemblyAI.

        This runs concurrently with the main function that receives transcripts.
        It establishes the WebSocket connection, streams all audio chunks,
        and signals completion when the input stream ends.
        """
        try:
            # Stream each audio chunk to AssemblyAI as it arrives
            async for audio_chunk in audio_stream:
                await stt.send_audio(audio_chunk)
        finally:
            # Signal to AssemblyAI that audio streaming is complete
            await stt.close()

    # Launch the audio sending task in the background
    # This allows us to simultaneously receive transcripts in the main coroutine
    send_task = asyncio.create_task(send_audio())

    try:
        # Consumer loop: receive and yield transcripts as they arrive from AssemblyAI
        # The receive_messages() method listens on the WebSocket for transcript events
        async for transcript in stt.receive_messages():
            if transcript:
                yield transcript
    finally:
        # Cleanup: ensure the background sending task is cancelled
        send_task.cancel()

        # Wait for the send task to finish cancellation gracefully
        # Suppress CancelledError since we intentionally cancelled it
        with contextlib.suppress(asyncio.CancelledError):
            await send_task

        # Close the WebSocket connection to AssemblyAI
        await stt.close()


async def _agent_stream(transcript_stream: AsyncIterator[str]) -> AsyncIterator[str]:
    """
    Transform stream: Transcripts (String) → Agent Responses (String)

    This function takes a stream of transcript strings from the STT stage and
    passes each one to the LangChain agent. The agent processes the transcript
    and streams back its response tokens, which are yielded one by one.

    Args:
        transcript_stream: An async iterator of transcript strings from the STT stage

    Yields:
        String chunks of the agent's response as they are generated
    """
    # Generate a unique thread ID for this conversation session
    # This allows the agent to maintain conversation context across multiple turns
    # using the checkpointer (InMemorySaver) configured in the agent
    thread_id = str(uuid4())

    # Process each transcript as it arrives from the upstream STT stage
    async for transcript in transcript_stream:
        # Stream the agent's response using LangChain's astream method
        stream = agent.astream(
            {"messages": [HumanMessage(content=transcript)]},
            {"configurable": {"thread_id": thread_id}},
            stream_mode="messages",
        )

        # Iterate through the agent's streaming response
        # The stream yields tuples of (message, metadata), but we only need the message
        async for message, _ in stream:
            # Extract and yield the text content from each message chunk
            # This allows downstream stages to process the response incrementally
            yield message.text


async def _tts_stream(response_stream: AsyncIterator[str]) -> AsyncIterator[bytes]:
    """
    Transform stream: Agent Response Text (String) → Audio (Bytes)

    This function takes a stream of text strings from the agent and converts them
    to PCM audio bytes using ElevenLabs' streaming TTS API. It manages the concurrent
    operations of sending text to ElevenLabs and receiving audio back.

    The uses a producer-consumer pattern where:
    - Producer: Reads text chunks from response_stream and sends them to ElevenLabs
    - Consumer: Receives audio chunks from ElevenLabs and yields them downstream

    Args:
        response_stream: An async iterator of text strings from the agent stage

    Yields:
        PCM audio bytes (16-bit, mono, 16kHz) as they are received from ElevenLabs
    """
    tts = ElevenLabsTTS()

    async def send_text():
        """
        Background task that reads text from response_stream and sends it to ElevenLabs.

        This runs concurrently with the main function, continuously reading text
        chunks from the agent's response stream and forwarding them to ElevenLabs
        for synthesis. This allows audio generation to begin before the agent has
        finished generating all text.
        """
        try:
            async for text in response_stream:
                # Send each text chunk to ElevenLabs for immediate synthesis
                # ElevenLabs will begin generating audio as soon as it receives text
                await tts.send_text(text)
        finally:
            # Signal to ElevenLabs that text sending is complete
            await tts.close()

    # Start the text sending task in the background
    # This allows us to simultaneously send text and receive audio
    send_task = asyncio.create_task(send_text())

    try:
        # Consumer loop: Receive audio chunks from ElevenLabs and yield them
        # This runs concurrently with send_text(), allowing audio to be streamed
        # to the client as it's generated, rather than waiting for all text first
        async for audio_chunk in tts.receive_audio():
            yield audio_chunk
    finally:
        # Cleanup: Ensure resources are properly released regardless of how we exit
        send_task.cancel()

        # Wait for the send task to finish cancellation gracefully
        # Suppress CancelledError since we intentionally cancelled it
        with contextlib.suppress(asyncio.CancelledError):
            await send_task

        # Close the WebSocket connection to ElevenLabs
        await tts.close()


# Define the voice processing pipeline as a chain of async generators
pipeline = (
    RunnableGenerator(_stt_stream)
    | RunnableGenerator(_agent_stream)
    | RunnableGenerator(_tts_stream)
)


@app.get("/")
async def serve_index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/{path:path}")
async def serve_path(path: str):
    return FileResponse(STATIC_DIR / path)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    async def websocket_audio_stream() -> AsyncIterator[bytes]:
        """Async generator that yields audio bytes from the websocket."""
        while True:
            data = await websocket.receive_bytes()
            yield data

    output_stream = pipeline.atransform(websocket_audio_stream())

    async for output_chunk in output_stream:
        await websocket.send_bytes(output_chunk)


if __name__ == "__main__":
    uvicorn.run("main:app", port=8000, reload=True)
