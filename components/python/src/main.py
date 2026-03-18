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
from state import build_voice_graph

LOGGER = logging.getLogger("uvicorn.error")

load_dotenv()
OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-4o-mini-realtime-preview")
OPENAI_STT_MODEL = os.getenv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe")
OPENAI_RESPONSE_LANGUAGE = os.getenv("OPENAI_RESPONSE_LANGUAGE", "en")
OPENAI_STT_LANGUAGE = os.getenv("OPENAI_STT_LANGUAGE", OPENAI_RESPONSE_LANGUAGE)
OPENAI_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "alloy")
OPENAI_TTS_LANGUAGE = os.getenv("OPENAI_TTS_LANGUAGE", OPENAI_RESPONSE_LANGUAGE)
OPENAI_TTS_RENDER_PROMPT_TEMPLATE = os.getenv(
    "OPENAI_TTS_RENDER_PROMPT_TEMPLATE",
    "Read the following text in {language}. Do not add anything else: {text}",
)
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
            "Connecting OpenAI realtime model=%s stt_model=%s",
            OPENAI_REALTIME_MODEL,
            OPENAI_STT_MODEL,
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
                        "turn_detection": {"type": "server_vad"},
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
        {
            "user_messages": [],
            "tool_completion_results": [],
            "llm_messages": [],
        },
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
        async for event in transcriber.receive_events():
            await websocket.send_json(event)
            if event.get("type") == "stt_output":
                await handler.apublish_to_channel(
                    "user_buffered_message",
                    event.get("transcript", ""),
                )

    async def pipe_graph_stream_to_client() -> None:
        while True:
            stream_event = await handler.receive_stream()
            if not stream_event:
                if run_result_task.done():
                    raise RuntimeError("SAF run completed unexpectedly")
                continue
            if isinstance(stream_event, dict):
                await websocket.send_json(stream_event)
                if stream_event.get("type") == "ai_text":
                    async for tts_event in speaker.synthesize(stream_event.get("text", "")):
                        await websocket.send_json(tts_event)

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
        handler.close_stream()
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
