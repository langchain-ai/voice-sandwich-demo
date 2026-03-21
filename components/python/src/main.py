import asyncio
import base64
import contextlib
import json
import logging
import os
from pathlib import Path
import time
from typing import AsyncIterator

import uvicorn
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles

load_dotenv()

try:
    from env import (
        OPENAI_REALTIME_MODEL,
        OPENAI_STT_LANGUAGE,
        OPENAI_STT_MODEL,
        OPENAI_VAD_PREFIX_PADDING_MS,
        OPENAI_VAD_SILENCE_DURATION_MS,
        OPENAI_VAD_THRESHOLD,
        OPENAI_TTS_LANGUAGE,
        OPENAI_TTS_RENDER_PROMPT_TEMPLATE,
        OPENAI_TTS_VOICE,
    )
    from state import build_voice_graph
except ModuleNotFoundError:  # pragma: no cover - package-style import fallback
    from src.env import (
        OPENAI_REALTIME_MODEL,
        OPENAI_STT_LANGUAGE,
        OPENAI_STT_MODEL,
        OPENAI_VAD_PREFIX_PADDING_MS,
        OPENAI_VAD_SILENCE_DURATION_MS,
        OPENAI_VAD_THRESHOLD,
        OPENAI_TTS_LANGUAGE,
        OPENAI_TTS_RENDER_PROMPT_TEMPLATE,
        OPENAI_TTS_VOICE,
    )
    from src.state import build_voice_graph

LOGGER = logging.getLogger("uvicorn.error")
OPENAI_REALTIME_URL = f"wss://api.openai.com/v1/realtime?model={OPENAI_REALTIME_MODEL}"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set")

VOICE_GRAPH = build_voice_graph()

# Static files are served from the shared web build output
STATIC_DIR = Path(__file__).parent.parent.parent / "web" / "dist"

if not STATIC_DIR.exists():
    raise RuntimeError(
        f"Web build not found at {STATIC_DIR}. "
        "Run 'make build-web' or 'make dev-py' from the project root."
    )

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class OpenAIRealtimeTranscriber:
    """Bridge PCM16 audio chunks to OpenAI Realtime transcription events."""

    def __init__(self, language: str = "en") -> None:
        self.language = language
        self._ws = None

    async def connect(self) -> None:
        LOGGER.info(
            "Connecting OpenAI realtime model=%s stt_model=%s vad(threshold=%s,prefix_ms=%s,silence_ms=%s)",
            OPENAI_REALTIME_MODEL,
            OPENAI_STT_MODEL,
            OPENAI_VAD_THRESHOLD,
            OPENAI_VAD_PREFIX_PADDING_MS,
            OPENAI_VAD_SILENCE_DURATION_MS,
        )
        self._ws = await websockets.connect(
            OPENAI_REALTIME_URL,
            additional_headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "OpenAI-Beta": "realtime=v1",
            },
        )
        await self._ws.send(
            json.dumps(
                {
                    "type": "session.update",
                    "session": {
                        "input_audio_format": "pcm16",
                        "input_audio_transcription": {
                            "model": OPENAI_STT_MODEL,
                            "language": self.language,
                        },
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": OPENAI_VAD_THRESHOLD,
                            "prefix_padding_ms": OPENAI_VAD_PREFIX_PADDING_MS,
                            "silence_duration_ms": OPENAI_VAD_SILENCE_DURATION_MS,
                        },
                    },
                }
            )
        )

    async def send_audio(self, audio_chunk: bytes) -> None:
        if not self._ws:
            raise RuntimeError("Realtime connection is not initialized")
        await self._ws.send(
            json.dumps(
                {
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(audio_chunk).decode("ascii"),
                }
            )
        )

    async def receive_events(self) -> AsyncIterator[dict]:
        if not self._ws:
            raise RuntimeError("Realtime connection is not initialized")
        async for raw_event in self._ws:
            event = json.loads(raw_event)
            event_type = event.get("type")

            if event_type == "conversation.item.input_audio_transcription.delta":
                delta = event.get("delta", "")
                if delta:
                    yield {
                        "type": "stt_chunk",
                        "who": "You",
                        "transcript": delta,
                        "ts": int(time.time() * 1000),
                    }
            elif event_type == "conversation.item.input_audio_transcription.completed":
                transcript = event.get("transcript", "")
                if transcript:
                    yield {
                        "type": "stt_output",
                        "who": "You",
                        "transcript": transcript,
                        "ts": int(time.time() * 1000),
                    }
            elif event_type == "error":
                LOGGER.error("OpenAI realtime error: %s", event)

    async def close(self) -> None:
        if self._ws and self._ws.close_code is None:
            await self._ws.close()
        self._ws = None


class OpenAIRealtimeSpeaker:
    """Generate streamed audio from text via OpenAI Realtime."""

    def __init__(self) -> None:
        self._ws = None

    async def connect(self) -> None:
        self._ws = await websockets.connect(
            OPENAI_REALTIME_URL,
            additional_headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "OpenAI-Beta": "realtime=v1",
            },
        )
        await self._ws.send(
            json.dumps(
                {
                    "type": "session.update",
                    "session": {
                        "output_audio_format": "pcm16",
                        "voice": OPENAI_TTS_VOICE,
                    },
                }
            )
        )

    async def synthesize(self, text: str) -> AsyncIterator[dict]:
        if not self._ws:
            raise RuntimeError("Realtime speaker connection is not initialized")
        render_text = OPENAI_TTS_RENDER_PROMPT_TEMPLATE.format(
            text=text, language=OPENAI_TTS_LANGUAGE
        )

        await self._ws.send(
            json.dumps(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {
                                "type": "input_text",
                                "text": render_text,
                            }
                        ],
                    },
                }
            )
        )
        await self._ws.send(
            json.dumps(
                {
                    "type": "response.create",
                    "response": {"modalities": ["audio", "text"]},
                }
            )
        )

        async for raw_event in self._ws:
            event = json.loads(raw_event)
            event_type = event.get("type")
            if event_type == "response.audio.delta":
                delta = event.get("delta", "")
                if delta:
                    yield {
                        "type": "ai_audio",
                        "who": "AI",
                        "audio": delta,
                        "ts": int(time.time() * 1000),
                    }
            elif event_type == "response.done":
                yield {
                    "type": "ai_audio_end",
                    "who": "AI",
                    "ts": int(time.time() * 1000),
                }
                break
            elif event_type == "error":
                LOGGER.error("OpenAI realtime TTS error: %s", event)
                break

    async def close(self) -> None:
        if self._ws and self._ws.close_code is None:
            await self._ws.close()
        self._ws = None


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    LOGGER.info("Client websocket accepted")

    handler = await VOICE_GRAPH.astart(
        {"TaskIdCounter": 0, "TopicIdCounter": 0},
        stream_mode="custom",
    )
    run_result_task = asyncio.create_task(handler.aresult())

    transcriber = OpenAIRealtimeTranscriber(language=OPENAI_STT_LANGUAGE)
    speaker = OpenAIRealtimeSpeaker()
    try:
        await transcriber.connect()
        await speaker.connect()
    except Exception:
        LOGGER.exception("Failed to initialize OpenAI realtime websocket")
        await websocket.send_json(
            {
                "type": "error",
                "message": (
                    "Failed to initialize realtime transcription. "
                    "Check OPENAI_REALTIME_MODEL / OPENAI_STT_MODEL."
                ),
                "ts": int(time.time() * 1000),
            }
        )
        await websocket.close(code=1011)
        return

    async def pipe_audio_to_openai() -> None:
        while True:
            audio_chunk = await websocket.receive_bytes()
            await transcriber.send_audio(audio_chunk)

    async def pipe_transcripts_to_client() -> None:
        last_published_transcript = ""
        async for event in transcriber.receive_events():
            await websocket.send_json(event)
            if event.get("type") == "stt_output":
                transcript = str(event.get("transcript", "")).strip()
                if not transcript:
                    continue
                if transcript == last_published_transcript:
                    LOGGER.info("Skip duplicate stt_output publish: %s", transcript)
                    continue
                await handler.apublish_to_channel("user_input", transcript)
                last_published_transcript = transcript

    async def pipe_graph_stream_to_client() -> None:
        async def consume_stream(stream_name: str) -> None:
            while True:
                stream_event = await handler.receive_stream(stream_name)
                if not stream_event:
                    if run_result_task.done():
                        raise RuntimeError("SAF run completed unexpectedly")
                    continue
                payload = stream_event if isinstance(stream_event, dict) else {"value": stream_event}
                payload.setdefault("type", stream_name)
                LOGGER.info("[ws] stream=%s payload=%s", stream_name, payload)
                await websocket.send_json(payload)
                if stream_name == "voice_output_stream":
                    text = str(payload.get("text", "")).strip()
                    if not text:
                        continue
                    async for tts_event in speaker.synthesize(text):
                        await websocket.send_json(tts_event)

        voice_task = asyncio.create_task(consume_stream("voice_output_stream"))
        detail_task = asyncio.create_task(consume_stream("detailed_output_stream"))
        done, pending = await asyncio.wait(
            {voice_task, detail_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.gather(*pending)
        for task in done:
            exc = task.exception()
            if exc:
                raise exc

    try:
        audio_task = asyncio.create_task(pipe_audio_to_openai())
        event_task = asyncio.create_task(pipe_transcripts_to_client())
        graph_stream_task = asyncio.create_task(pipe_graph_stream_to_client())
        done, pending = await asyncio.wait(
            {audio_task, event_task, graph_stream_task, run_result_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.gather(*pending)
        for task in done:
            exc = task.exception()
            if not exc:
                continue
            if isinstance(exc, WebSocketDisconnect):
                continue
            if task is run_result_task:
                LOGGER.error("SAF run ended unexpectedly: %s", exc)
            else:
                LOGGER.exception("Websocket pipeline task failed", exc_info=exc)
            with contextlib.suppress(Exception):
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": "Session pipeline failed. Please restart session.",
                        "ts": int(time.time() * 1000),
                    }
                )
            break
    except WebSocketDisconnect:
        LOGGER.info("Client websocket disconnected")
    finally:
        handler.close_all_streams()
        if not run_result_task.done():
            run_result_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await run_result_task
        await transcriber.close()
        await speaker.close()
        with contextlib.suppress(RuntimeError):
            await websocket.close()


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    uvicorn.run("main:app", port=8000, reload=True)
