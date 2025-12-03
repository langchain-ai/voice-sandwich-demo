"""
ElevenLabs Text-to-Speech Streaming

Python implementation of ElevenLabs streaming TTS API.
Converts text to PCM audio in real-time using WebSocket streaming.

Input: Text strings
Output: PCM audio bytes (16-bit, mono, 16kHz)
"""

import asyncio
import base64
import json
import os
from typing import AsyncIterator, Optional

import websockets
from websockets.client import WebSocketClientProtocol


class ElevenLabsTTSTransform:
    """
    ElevenLabs streaming TTS transform.

    Provides async streaming text-to-speech using ElevenLabs API.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        voice_id: str = "21m00Tcm4TlvDq8ikWAM",  # Default: Rachel
        model_id: str = "eleven_multilingual_v2",
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        output_format: str = "pcm_16000",
    ):
        """
        Initialize ElevenLabs TTS transform.

        Args:
            api_key: ElevenLabs API key (defaults to ELEVENLABS_API_KEY env var)
            voice_id: Voice ID to use (default: Rachel)
            model_id: Model ID (default: eleven_monolingual_v1)
            stability: Voice stability (0-1, default: 0.5)
            similarity_boost: Voice similarity boost (0-1, default: 0.75)
            output_format: Audio output format (default: pcm_16000)
        """
        self.api_key = api_key or os.getenv("ELEVENLABS_API_KEY")
        if not self.api_key:
            raise ValueError("ElevenLabs API key is required")

        self.voice_id = voice_id
        self.model_id = model_id
        self.stability = stability
        self.similarity_boost = similarity_boost
        self.output_format = output_format
        self.ws: Optional[WebSocketClientProtocol] = None

    async def connect(self) -> None:
        """Establish WebSocket connection to ElevenLabs."""
        if self.ws and self.ws.close_code is None:
            return

        url = (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream-input"
            f"?model_id={self.model_id}&output_format={self.output_format}"
        )
        print(f"ElevenLabs: Connecting to {url}")

        self.ws = await websockets.connect(url)
        print("ElevenLabs: WebSocket connected")

        # Send BOS (Beginning of Stream) message
        bos_message = {
            "text": " ",
            "voice_settings": {
                "stability": self.stability,
                "similarity_boost": self.similarity_boost,
            },
            "xi_api_key": self.api_key,
        }
        await self.ws.send(json.dumps(bos_message))
        print("ElevenLabs: Sent BOS message")

    async def send_text(self, text: str, try_trigger_generation: bool = True) -> None:
        """
        Send text chunk to ElevenLabs for synthesis.

        Args:
            text: Text to synthesize
            try_trigger_generation: Force low latency generation (default: True)
        """
        # Skip empty text chunks
        if not text or not text.strip():
            print("[DEBUG] ElevenLabs: Skipping empty text chunk")
            return

        if not self.ws or self.ws.close_code is not None:
            await self.connect()

        if self.ws and self.ws.close_code is None:
            payload = {"text": text, "try_trigger_generation": try_trigger_generation}
            print(f"[DEBUG] ElevenLabs: Sending text: {repr(text)}")
            await self.ws.send(json.dumps(payload))
        else:
            print(f"ElevenLabs: WebSocket not open, dropping text: {text}")

    async def flush(self) -> None:
        """Signal end of text input."""
        if self.ws and self.ws.close_code is None:
            print("ElevenLabs: Flushing stream...")
            # Give ElevenLabs time to process text before flushing
            await asyncio.sleep(0.5)
            await self.ws.send(json.dumps({"text": ""}))
            await asyncio.sleep(5.0)  # Wait for final audio

    async def close(self) -> None:
        """Close the WebSocket connection."""
        if self.ws and self.ws.close_code is None:
            await self.ws.close()
        self.ws = None

    async def receive_audio(self) -> AsyncIterator[bytes]:
        """
        Receive audio chunks from ElevenLabs.

        Yields:
            PCM audio bytes (16-bit, mono, 16kHz)
        """
        if not self.ws:
            raise RuntimeError("WebSocket not connected")

        try:
            async for raw_message in self.ws:
                try:
                    message = json.loads(raw_message)
                    # print(f"[DEBUG] ElevenLabs: Received message: {message}")

                    if "audio" in message and message["audio"] is not None:
                        # Decode base64 audio
                        audio_chunk = base64.b64decode(message["audio"])
                        if audio_chunk:  # Only yield if we have audio data
                            chunk_len = len(audio_chunk)
                            print(f"[DEBUG] ElevenLabs: chunk ({chunk_len} bytes)")
                            yield audio_chunk

                    if message.get("isFinal"):
                        print("ElevenLabs: Received isFinal signal")
                        break

                    if "error" in message:
                        print(f"ElevenLabs: Server error: {message}")
                        err_json = json.dumps(message, indent=2)
                        print(f"[DEBUG] Full error message: {err_json}")

                except json.JSONDecodeError as e:
                    print(f"ElevenLabs: Error parsing message: {e}")

        except websockets.exceptions.ConnectionClosed:
            print("ElevenLabs: WebSocket connection closed")
        finally:
            await self.close()

    async def synthesize_stream(
        self, text_stream: AsyncIterator[str]
    ) -> AsyncIterator[bytes]:
        """
        Synthesize a stream of text chunks to audio.

        Args:
            text_stream: Async iterator of text strings

        Yields:
            PCM audio bytes (16-bit, mono, 16kHz)
        """
        try:
            # Connect to ElevenLabs
            await self.connect()

            # Start receiving audio in background
            async def send_text_task():
                try:
                    async for text_chunk in text_stream:
                        await self.send_text(text_chunk)
                    # Signal end of text
                    await self.flush()
                except Exception as e:
                    print(f"ElevenLabs: Error sending text: {e}")

            send_task = asyncio.create_task(send_text_task())

            # Yield audio chunks as they arrive
            async for audio_chunk in self.receive_audio():
                yield audio_chunk

            # Wait for send task to complete
            try:
                await asyncio.wait_for(send_task, timeout=5.0)
            except asyncio.TimeoutError:
                print("ElevenLabs: Timeout waiting for text send to complete")

        finally:
            await self.close()


async def text_to_speech_stream(
    text_stream: AsyncIterator[str],
    api_key: Optional[str] = None,
    voice_id: str = "21m00Tcm4TlvDq8ikWAM",
) -> AsyncIterator[bytes]:
    """
    Helper function to convert text stream to audio using ElevenLabs.

    Args:
        text_stream: Async iterator of text strings
        api_key: ElevenLabs API key (defaults to ELEVENLABS_API_KEY env var)
        voice_id: Voice ID to use (default: Rachel)

    Yields:
        PCM audio bytes (16-bit, mono, 16kHz)

    Example:
        ```python
        async def speak():
            async for audio_chunk in text_to_speech_stream(text_stream):
                # Play audio_chunk
                pass
        ```
    """
    transform = ElevenLabsTTSTransform(api_key=api_key, voice_id=voice_id)

    async for audio_chunk in transform.synthesize_stream(text_stream):
        yield audio_chunk
