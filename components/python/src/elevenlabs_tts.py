"""
ElevenLabs Text-to-Speech Streaming

Python implementation of ElevenLabs streaming TTS API.
Converts text to PCM audio in real-time using WebSocket streaming.

Input: Text strings
Output: PCM audio bytes (16-bit, mono, 16kHz)
"""

import asyncio
import base64
import contextlib
import json
import os
from typing import AsyncIterator, Optional

import websockets
from websockets.client import WebSocketClientProtocol


class ElevenLabsTTS:
    _ws: Optional[WebSocketClientProtocol]
    _connection_signal: asyncio.Event
    _close_signal: asyncio.Event

    def __init__(
        self,
        api_key: Optional[str] = None,
        voice_id: str = "21m00Tcm4TlvDq8ikWAM",  # Default: Rachel
        model_id: str = "eleven_multilingual_v2",
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        output_format: str = "pcm_16000",
        trigger_generation: bool = False,
    ):
        self.api_key = api_key or os.getenv("ELEVENLABS_API_KEY")
        if not self.api_key:
            raise ValueError("ElevenLabs API key is required")

        self.voice_id = voice_id
        self.model_id = model_id
        self.stability = stability
        self.similarity_boost = similarity_boost
        self.output_format = output_format
        self.trigger_generation = trigger_generation
        self._ws = None
        self._connection_signal = asyncio.Event()
        self._close_signal = asyncio.Event()

    async def send_text(self, text: str) -> None:
        if not text or not text.strip():
            return

        ws = await self._ensure_connection()
        payload = {
            "text": text,
            "try_trigger_generation": self.trigger_generation,
        }
        await ws.send(json.dumps(payload))

    async def receive_audio(self) -> AsyncIterator[bytes]:
        while not self._close_signal.is_set():
            _, pending = await asyncio.wait(
                [
                    asyncio.create_task(self._close_signal.wait()),
                    asyncio.create_task(self._connection_signal.wait()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )

            with contextlib.suppress(asyncio.CancelledError):
                for task in pending:
                    task.cancel()

            if self._close_signal.is_set():
                break

            if self._ws and self._ws.close_code is not None:
                self._connection_signal.clear()
                try:
                    async for raw_message in self._ws:
                        try:
                            message = json.loads(raw_message)
                            if "audio" in message and message["audio"] is not None:
                                audio_chunk = base64.b64decode(message["audio"])
                                if audio_chunk:
                                    yield audio_chunk
                            if message.get("isFinal"):
                                print("[DEBUG] ElevenLabs: Turn complete (isFinal)")
                                break
                            if "error" in message:
                                print(f"[DEBUG] ElevenLabs error: {message}")
                                break
                        except json.JSONDecodeError as e:
                            print(f"[DEBUG] ElevenLabs JSON decode error: {e}")
                            continue
                except websockets.exceptions.ConnectionClosed:
                    print("ElevenLabs: WebSocket connection closed")

    async def close(self) -> None:
        if self._ws and self._ws.close_code is None:
            await self._ws.close()
        self._ws = None
        self._close_signal.set()

    async def _ensure_connection(self) -> WebSocketClientProtocol:
        if self._close_signal.is_set():
            raise RuntimeError(
                "ElevenLabsTTS tried establishing a connection after it was closed"
            )
        if self._ws and self._ws.close_code is None:
            return self._ws

        url = (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream-input"
            f"?model_id={self.model_id}&output_format={self.output_format}"
        )
        self._ws = await websockets.connect(url)

        bos_message = {
            "text": " ",
            "voice_settings": {
                "stability": self.stability,
                "similarity_boost": self.similarity_boost,
            },
            "xi_api_key": self.api_key,
        }
        await self._ws.send(json.dumps(bos_message))

        self._connection_signal.set()
        return self._ws
