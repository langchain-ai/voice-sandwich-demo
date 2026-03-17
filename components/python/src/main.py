import contextlib
import logging
from pathlib import Path
import tempfile
import time

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from starlette.staticfiles import StaticFiles

LOGGER = logging.getLogger("uvicorn.error")

load_dotenv()
OPENAI_STT_MODEL = "gpt-4o-transcribe"
OPENAI_CLIENT = OpenAI()

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


@app.post("/api/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    language: str = Form("en"),
) -> dict:
    """Transcribe one uploaded audio clip with OpenAI Speech-to-Text."""
    suffix = Path(audio.filename or "recording.webm").suffix or ".webm"
    temp_dir = Path(tempfile.gettempdir()) / "voice-sandwich-demo-stt"
    temp_dir.mkdir(parents=True, exist_ok=True)
    temp_path = temp_dir / f"session-{int(time.time() * 1000)}{suffix}"

    try:
        raw_audio = await audio.read()
        if not raw_audio:
            raise HTTPException(status_code=400, detail="Empty audio payload")
        temp_path.write_bytes(raw_audio)

        with temp_path.open("rb") as audio_file:
            response = OPENAI_CLIENT.audio.transcriptions.create(
                model=OPENAI_STT_MODEL,
                file=audio_file,
                language=language,
            )

        transcript = getattr(response, "text", "").strip()
        return {
            "type": "stt_output",
            "transcript": transcript,
            "ts": int(time.time() * 1000),
        }
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover - network/provider issues
        LOGGER.exception("Transcription request failed")
        raise HTTPException(status_code=500, detail="Failed to transcribe audio") from exc
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp_path.unlink()


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    uvicorn.run("main:app", port=8000, reload=True)
