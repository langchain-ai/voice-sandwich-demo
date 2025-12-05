"""
AssemblyAI Real-Time Streaming STT Transform

Python implementation that mirrors the TypeScript AssemblyAISTTTransform.
Connects to AssemblyAI's v3 WebSocket API for streaming speech-to-text.

Input: PCM 16-bit audio buffer (bytes)
Output: STT events (stt_chunk for partials, stt_output for final transcripts)
"""

import asyncio
import contextlib
import json
import os
from typing import AsyncIterator, Optional
from urllib.parse import urlencode

import websockets
from websockets.client import WebSocketClientProtocol

from events import STTChunkEvent, STTEvent, STTOutputEvent


class AssemblyAISTT:
    def __init__(
        self,
        api_key: Optional[str] = None,
        sample_rate: int = 16000,
        format_turns: bool = True,
    ):
        self.api_key = api_key or os.getenv("ASSEMBLYAI_API_KEY")
        if not self.api_key:
            raise ValueError("AssemblyAI API key is required")

        self.sample_rate = sample_rate
        self.format_turns = format_turns
        self._ws: Optional[WebSocketClientProtocol] = None
        self._connection_signal = asyncio.Event()
        self._close_signal = asyncio.Event()

    async def receive_events(self) -> AsyncIterator[STTEvent]:
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

            if self._ws and self._ws.close_code is None:
                self._connection_signal.clear()
                try:
                    async for raw_message in self._ws:
                        try:
                            message = json.loads(raw_message)
                            message_type = message.get("type")

                            if message_type == "Begin":
                                pass
                            elif message_type == "Turn":
                                transcript = message.get("transcript", "")
                                turn_is_formatted = message.get(
                                    "turn_is_formatted", False
                                )

                                if turn_is_formatted:
                                    if transcript:
                                        yield STTOutputEvent.create(transcript)
                                else:
                                    yield STTChunkEvent.create(transcript)

                            elif message_type == "Termination":
                                # no-op
                                pass
                            else:
                                if "error" in message:
                                    print(f"AssemblyAISTT error: {message['error']}")
                                    break
                        except json.JSONDecodeError as e:
                            print(f"[DEBUG] AssemblyAISTT JSON decode error: {e}")
                            continue
                except websockets.exceptions.ConnectionClosed:
                    print("AssemblyAISTT: WebSocket connection closed")

    async def send_audio(self, audio_chunk: bytes) -> None:
        ws = await self._ensure_connection()
        await ws.send(audio_chunk)

    async def close(self) -> None:
        if self._ws and self._ws.close_code is None:
            await self._ws.close()
        self._ws = None
        self._close_signal.set()

    async def _ensure_connection(self) -> WebSocketClientProtocol:
        if self._close_signal.is_set():
            raise RuntimeError(
                "AssemblyAISTT tried establishing a connection after it was closed"
            )
        if self._ws and self._ws.close_code is None:
            return self._ws

        params = urlencode(
            {
                "sample_rate": self.sample_rate,
                "format_turns": str(self.format_turns).lower(),
            }
        )
        url = f"wss://streaming.assemblyai.com/v3/ws?{params}"
        self._ws = await websockets.connect(
            url, additional_headers={"Authorization": self.api_key}
        )

        self._connection_signal.set()
        return self._ws
