"""
Voice Agent Event Types

Python implementation of the voice agent event system.
All events in the pipeline share common properties to enable
consistent handling, logging, and debugging across the system.

This module defines typed dataclasses for all events that flow through
the voice agent pipeline, from user audio input through STT, agent
processing, and TTS output.
"""

import base64
import time
from dataclasses import dataclass
from typing import Literal, Union


def _now_ms() -> int:
    """Return current Unix timestamp in milliseconds."""
    return int(time.time() * 1000)


@dataclass
class UserInputEvent:
    """
    Event emitted when raw audio data is received from the user.

    This is the entry point of the voice agent pipeline. Audio should be
    in PCM format (16-bit, mono, 16kHz) for optimal processing by the STT stage.
    """

    type: Literal["user_input"]

    audio: bytes
    """
    Raw PCM audio bytes from the user's microphone.
    Expected format: 16-bit signed integer, mono channel, 16kHz sample rate.
    """

    ts: int
    """Unix timestamp (milliseconds since epoch) when the event was created."""

    @classmethod
    def create(cls, audio: bytes) -> "UserInputEvent":
        """Factory method to create a UserInputEvent event with current timestamp."""
        return cls(type="user_input", audio=audio, ts=_now_ms())


@dataclass
class STTChunkEvent:
    """
    Event emitted during speech-to-text processing for partial transcription results.

    STT services often provide incremental results as they process audio.
    These chunks allow for real-time display of transcription progress to the user,
    improving perceived responsiveness even before the final transcript is ready.
    """

    type: Literal["stt_chunk"]

    transcript: str
    """
    Partial transcript text from the STT service.
    This may be revised as more audio context becomes available.
    Not guaranteed to be the final transcription.
    """

    ts: int
    """Unix timestamp (milliseconds since epoch) when the event was created."""

    @classmethod
    def create(cls, transcript: str) -> "STTChunkEvent":
        """Factory method to create an STTChunkEvent event with current timestamp."""
        return cls(type="stt_chunk", transcript=transcript, ts=_now_ms())


@dataclass
class STTOutputEvent:
    """
    Event emitted when speech-to-text processing completes for a turn.

    This represents the final, formatted transcription of the user's speech.
    Unlike STTChunkEvent, this is the complete and finalized transcript that will
    be sent to the agent for processing.
    """

    type: Literal["stt_output"]

    transcript: str
    """
    Final, complete transcript of the user's speech for this turn.
    This is the text that will be processed by the LLM agent.
    """

    ts: int
    """Unix timestamp (milliseconds since epoch) when the event was created."""

    @classmethod
    def create(cls, transcript: str) -> "STTOutputEvent":
        """Factory method to create an STTOutputEvent event with current timestamp."""
        return cls(type="stt_output", transcript=transcript, ts=_now_ms())


STTEvent = Union[STTChunkEvent, STTOutputEvent]


@dataclass
class AgentChunkEvent:
    """
    Event emitted during agent response generation for streaming text chunks.

    As the LLM generates its response, it streams tokens incrementally.
    These chunks enable real-time display of the agent's response and allow
    the TTS stage to begin synthesis before the complete response is generated,
    reducing overall latency.
    """

    type: Literal["agent_chunk"]

    text: str
    """
    Partial text chunk from the agent's streaming response.
    Multiple chunks combine to form the complete agent output.
    """

    ts: int
    """Unix timestamp (milliseconds since epoch) when the event was created."""

    @classmethod
    def create(cls, text: str) -> "AgentChunkEvent":
        """Factory method to create an AgentChunkEvent event with current timestamp."""
        return cls(type="agent_chunk", text=text, ts=_now_ms())


@dataclass
class AgentEndEvent:
    """
    Event emitted when the agent has finished generating its response for a turn.

    This signals downstream consumers (like TTS) that no more text is coming
    for this turn and they should flush any buffered content.
    """

    type: Literal["agent_end"]

    ts: int
    """Unix timestamp (milliseconds since epoch) when the event was created."""

    @classmethod
    def create(cls) -> "AgentEndEvent":
        """Factory method to create an AgentEndEvent event with current timestamp."""
        return cls(type="agent_end", ts=_now_ms())


@dataclass
class ToolCallEvent:
    """
    Event emitted when the agent invokes a tool.

    This event provides visibility into the agent's decision-making process,
    showing which tools are being called and with what arguments.
    """

    type: Literal["tool_call"]

    id: str
    """Unique identifier for this tool invocation."""

    name: str
    """Name of the tool being invoked."""

    args: dict
    """Arguments passed to the tool."""

    ts: int
    """Unix timestamp (milliseconds since epoch) when the event was created."""

    @classmethod
    def create(cls, id: str, name: str, args: dict) -> "ToolCallEvent":
        """Factory method to create a ToolCallEvent event with current timestamp."""
        return cls(type="tool_call", id=id, name=name, args=args, ts=_now_ms())


@dataclass
class ToolResultEvent:
    """
    Event emitted when a tool completes execution and returns a result.

    This event contains the output from the tool, allowing tracking of
    the full tool execution lifecycle.
    """

    type: Literal["tool_result"]

    tool_call_id: str
    """The tool call ID this result corresponds to."""

    name: str
    """Name of the tool that was executed."""

    result: str
    """The result returned by the tool."""

    ts: int
    """Unix timestamp (milliseconds since epoch) when the event was created."""

    @classmethod
    def create(cls, tool_call_id: str, name: str, result: str) -> "ToolResultEvent":
        """Factory method to create a ToolResultEvent event with current timestamp."""
        return cls(
            type="tool_result",
            tool_call_id=tool_call_id,
            name=name,
            result=result,
            ts=_now_ms(),
        )


AgentEvent = Union[AgentChunkEvent, AgentEndEvent, ToolCallEvent, ToolResultEvent]
"""
Union type of all agent-related events.

This type encompasses all events emitted during agent processing, including
streaming text chunks, tool invocations, and completion signals. It enables
type-safe handling of the various stages of agent response generation.
"""


@dataclass
class TTSChunkEvent:
    """
    Event emitted during text-to-speech synthesis for streaming audio chunks.

    As the TTS service synthesizes speech, it streams audio incrementally.
    These chunks enable real-time playback of the agent's response, allowing
    audio to begin playing before the complete synthesis is finished, which
    significantly improves perceived responsiveness.
    """

    type: Literal["tts_chunk"]

    audio: bytes
    """
    PCM audio bytes synthesized from the agent's text response.
    Format: 16-bit signed integer, mono channel, 24kHz sample rate.
    Encoded as base64 when serialized to JSON for transmission.
    Can be played immediately as it arrives for low-latency audio output.
    """

    ts: int
    """Unix timestamp (milliseconds since epoch) when the event was created."""

    @classmethod
    def create(cls, audio: bytes) -> "TTSChunkEvent":
        """Factory method to create a TTSChunkEvent event with current timestamp."""
        return cls(type="tts_chunk", audio=audio, ts=_now_ms())


VoiceAgentEvent = Union[UserInputEvent, STTEvent, AgentEvent, TTSChunkEvent]


def event_to_dict(event: VoiceAgentEvent) -> dict:
    """Convert a VoiceAgentEvent to a JSON-serializable dictionary."""
    if isinstance(event, UserInputEvent):
        return {"type": event.type, "ts": event.ts}
    elif isinstance(event, STTChunkEvent):
        return {"type": event.type, "transcript": event.transcript, "ts": event.ts}
    elif isinstance(event, STTOutputEvent):
        return {"type": event.type, "transcript": event.transcript, "ts": event.ts}
    elif isinstance(event, AgentChunkEvent):
        return {"type": event.type, "text": event.text, "ts": event.ts}
    elif isinstance(event, AgentEndEvent):
        return {"type": event.type, "ts": event.ts}
    elif isinstance(event, ToolCallEvent):
        return {
            "type": event.type,
            "id": event.id,
            "name": event.name,
            "args": event.args,
            "ts": event.ts,
        }
    elif isinstance(event, ToolResultEvent):
        return {
            "type": event.type,
            "toolCallId": event.tool_call_id,
            "name": event.name,
            "result": event.result,
            "ts": event.ts,
        }
    elif isinstance(event, TTSChunkEvent):
        return {
            "type": event.type,
            "audio": base64.b64encode(event.audio).decode("ascii"),
            "ts": event.ts,
        }
    else:
        raise ValueError(f"Unknown event type: {type(event)}")
