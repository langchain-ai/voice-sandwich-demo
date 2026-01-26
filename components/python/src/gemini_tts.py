"""
Gemini Text-to-Speech Streaming

Python implementation of Gemini 2.5 Flash TTS API.
Converts text to PCM audio using the Google GenAI SDK.

Input: Text strings
Output: TTS events (tts_chunk for audio chunks)
"""

import asyncio
import os
from typing import AsyncIterator, Optional, Literal

from google import genai
from google.genai import types

from events import TTSChunkEvent


class GeminiTTS:
    _close_signal: asyncio.Event
    _text_queue: asyncio.Queue
    _processing_task: Optional[asyncio.Task]

    def __init__(
        self,
        api_key: Optional[str] = None,
        model_id: str = "gemini-2.5-flash-preview-tts",
        voice_name: str = "Puck",
        sample_rate: int = 24000,
        language: Optional[str] = None,
    ):
        """
        Initialize Gemini TTS.
        
        Args:
            api_key: Gemini API key (or set GEMINI_API_KEY env var)
            model_id: Model to use (default: gemini-2.5-flash-preview-tts)
            voice_name: Voice from the 30 available voices (default: Puck - Upbeat)
            sample_rate: Audio sample rate (default: 24000)
            language: Optional language code (e.g., 'en-US'). Auto-detected if None.
        
        Available voices:
            Bright: Zephyr, Kore, Orus, Autonoe
            Upbeat: Puck, Laomedeia
            Informative: Charon, Rasalgethi
            Firm: Kore, Orus, Alnilam
            Excitable: Fenrir
            Youthful: Leda
            Easy-going: Callirrhoe, Umbriel
            Breezy: Aoede
            Breathy: Enceladus
            Clear: Iapetus, Erinome
            Smooth: Algieba, Despina
            Gravelly: Algenib
            Soft: Achernar
            Even: Schedar
            Mature: Gacrux
            Forward: Pulcherrima
            Gentle: Vindemiatrix
            Friendly: Achird
            Casual: Zubenelgenubi
            Lively: Sadachbia
            Knowledgeable: Sadaltager
            Warm: Sulafat
        """
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError("Gemini API key is required")

        self.model_id = model_id
        self.voice_name = voice_name
        self.sample_rate = sample_rate
        self.language = language
        
        # Initialize the Gemini client
        self.client = genai.Client(api_key=self.api_key)
        
        self._close_signal = asyncio.Event()
        self._text_queue = asyncio.Queue()
        self._processing_task = None

    async def send_text(self, text: Optional[str]) -> None:
        """
        Queue text for TTS generation.
        
        Args:
            text: Text to convert to speech
        """
        if text is None:
            return

        if not text.strip():
            return

        await self._text_queue.put(text)

    async def receive_events(self) -> AsyncIterator[TTSChunkEvent]:
        """
        Receive audio chunks as they're generated.
        Processes queued text and yields audio chunks.
        """
        while not self._close_signal.is_set():
            try:
                # Wait for text with timeout to check close signal periodically
                text = await asyncio.wait_for(
                    self._text_queue.get(), 
                    timeout=0.1
                )
                
                # Generate audio for this text
                try:
                    audio_data = await self._generate_audio(text)
                    
                    # Split audio into chunks for streaming
                    # Using 4096 byte chunks (reasonable for real-time streaming)
                    chunk_size = 4096
                    for i in range(0, len(audio_data), chunk_size):
                        if self._close_signal.is_set():
                            break
                        chunk = audio_data[i:i + chunk_size]
                        if chunk:
                            yield TTSChunkEvent.create(chunk)
                    
                    print(f"[DEBUG] Gemini: Completed TTS for text ({len(audio_data)} bytes)")
                    
                except Exception as e:
                    print(f"[DEBUG] Gemini TTS error: {e}")
                    
            except asyncio.TimeoutError:
                # No text available, continue checking
                continue
            except Exception as e:
                print(f"[DEBUG] Gemini receive_events error: {e}")
                break

    async def _generate_audio(self, text: str) -> bytes:
        """
        Generate audio from text using Gemini API.
        
        Args:
            text: Text to convert to speech
            
        Returns:
            Raw PCM audio data
        """
        # Build the speech config
        speech_config = types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name=self.voice_name,
                )
            )
        )
        
        # Build the generation config
        config = types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=speech_config,
        )
        
        # Run the blocking API call in a thread pool
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: self.client.models.generate_content(
                model=self.model_id,
                contents=text,
                config=config,
            )
        )
        
        # Extract audio data from response
        audio_data = response.candidates[0].content.parts[0].inline_data.data
        return audio_data

    async def close(self) -> None:
        """Close the TTS service and cleanup resources."""
        self._close_signal.set()
        
        # Clear any pending text in queue
        while not self._text_queue.empty():
            try:
                self._text_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        
        if self._processing_task and not self._processing_task.done():
            self._processing_task.cancel()
            try:
                await self._processing_task
            except asyncio.CancelledError:
                pass
        
        print("[DEBUG] Gemini TTS: Closed")