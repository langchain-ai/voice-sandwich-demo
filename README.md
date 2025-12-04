# Voice Sandwich Demo 🥪

A demo of a real-time, voice-to-voice AI pipeline orchestrated using the **Web Streams API** on Node.js.

## Architecture & Data Flow

This project is architected entirely around standard `ReadableStream`, `WritableStream`, and `TransformStream` interfaces. This approach allows for efficient, backpressure-aware data processing where each step in the pipeline handles a specific transformation of the audio or text signal.

### Pipeline Diagram

```mermaid
flowchart TD
    subgraph Client [Browser Client]
        Mic[Microphone] -->|Opus/WebM Stream| WS_Out[WebSocket]
        WS_In[WebSocket] -->|PCM Float32 Stream| Speaker[AudioContext]
    end

    subgraph Server [Node.js Hono Server]
        WS_Receiver[WS Receiver] -->|Buffer Stream| Pipeline
        
        subgraph Pipeline [Web Streams Pipeline]
            direction TB
            Opus[OpusToPcmTransform] -->|Raw PCM Int16| VAD[VADBufferTransform]
            VAD -->|Buffered Speech| STT[OpenAISTTTransform]
            STT -->|Text String| Agent[AgentTransform]
            Agent -->|AIMessageChunk| Filter[MessageChunkTransform]
            Filter -->|Text Stream| Chunker[SentenceChunkerTransform]
            Chunker -->|Sentence String| TTS[ElevenLabsTTSTransform]
        end

        TTS -->|PCM Int16 Buffer| WS_Sender[WS Sender]
    end

    WS_Out <--> WS_Receiver
    WS_Sender <--> WS_In
```

### The Web Streams Implementation

The core logic resides in `packages/web/src/index.ts`, where the pipeline is composed:

```typescript
inputStream
  .pipeThrough(new OpusToPcmTransform())       // ffmpeg: WebM -> PCM
  .pipeThrough(new VADBufferTransform())       // Silero VAD: Gates stream on speech detection
  .pipeThrough(new OpenAISTTTransform())       // OpenAI Whisper: Audio Buffer -> Text
  .pipeThrough(new AgentTransform(graph))      // LangGraph: Text -> Streaming AI Tokens
  .pipeThrough(new AIMessageChunkTransform())  // Formatting: Chunk -> String
  .pipeThrough(new SentenceChunkTransform())   // Optimization: Buffers tokens into sentences
  .pipeThrough(new ElevenLabsTTSTransform())   // ElevenLabs: Text -> Streaming Audio
```

### Key Components

1.  **`OpusToPcmTransform`**: Spawns an `ffmpeg` process to transcode the incoming browser-native WebM/Opus stream into raw PCM (16kHz, 16-bit, Mono) required for VAD and downstream processing.
2.  **`VADBufferTransform`**: Utilizes `@ericedouard/vad-node-realtime` (running the Silero VAD model via ONNX) to analyze the PCM stream. It acts as a gate, buffering audio frames and only emitting a consolidated buffer when a "speech end" event is triggered.
3.  **`AgentTransform`**: Wraps a **createAgent** / **LangGraph** runnable. It takes a string input (transcription), runs the agent graph, and streams the resulting `AIMessageChunk` objects.
4.  **`ElevenLabsTTSTransform`**: Manages a WebSocket connection to ElevenLabs. It sends text sentences as they become available and yields the returned PCM audio buffers.

## Prerequisites

- **ffmpeg** (system installed, required for both implementations)

### TypeScript Implementation
- **Node.js** (v18+)
- **pnpm** (or npm)
- **API Keys**:
  - `OPENAI_API_KEY`: For Whisper STT
  - `ELEVENLABS_API_KEY` & `ELEVENLABS_VOICE_ID`: For Text-to-Speech
  - `GOOGLE_API_KEY`: For the Gemini model driving the LangGraph agent

### Python Implementation
- **Python** (3.11+)
- **uv** (Python package manager)
- **API Keys**:
  - `ANTHROPIC_API_KEY`: For Claude model driving the LangGraph agent
  - `ASSEMBLYAI_API_KEY`: For Speech-to-Text
  - `ELEVENLABS_API_KEY` & `ELEVENLABS_VOICE_ID`: For Text-to-Speech

## Setup & Running

You can run either the TypeScript or Python implementation. Both serve the same web interface.

### Option 1: TypeScript Implementation

1.  **Install Dependencies**:
    ```bash
    cd components/typescript
    npm install
    ```

2.  **Environment Configuration**:
    Create `components/typescript/.env`:
    ```env
    OPENAI_API_KEY=sk-...
    ELEVENLABS_API_KEY=...
    ELEVENLABS_VOICE_ID=...
    GOOGLE_API_KEY=...
    ```

3.  **Start Server**:
    ```bash
    npm run server
    ```
    The app will be available at `http://localhost:3000`

### Option 2: Python Implementation

1.  **Install Dependencies**:
    ```bash
    cd components/python
    uv sync --dev
    ```

2.  **Environment Configuration**:
    Create `components/python/.env`:
    ```env
    ANTHROPIC_API_KEY=...
    ASSEMBLYAI_API_KEY=...
    ELEVENLABS_API_KEY=...
    ELEVENLABS_VOICE_ID=...
    ```

3.  **Start Server**:
    ```bash
    uv run src/main.py
    ```
    The app will be available at `http://localhost:8000`

### Using Make (Both Implementations)

Alternatively, you can use the provided Makefile:

```bash
# Install both implementations
make bootstrap

# Run TypeScript server
make start-ts

# Run Python server
make start-py
```