// Server event types
export type ServerEvent =
  | { type: "stt_chunk"; ts: number; transcript: string }
  | { type: "stt_output"; ts: number; transcript: string }
  | { type: "agent_chunk"; ts: number; text: string }
  | {
      type: "tool_call";
      ts: number;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_result"; ts: number; name: string; result: string }
  | { type: "tts_chunk"; audio: string; ts: number };

// Session state
export interface SessionState {
  connected: boolean;
  recording: boolean;
  status: "ready" | "connecting" | "listening" | "error" | "disconnected";
  startTime: number | null;
  elapsed: number;
}

// Pipeline turn state
export interface TurnState {
  active: boolean;
  turnStartTs: number | null;
  sttStartTs: number | null;
  sttEndTs: number | null;
  agentStartTs: number | null;
  agentEndTs: number | null;
  ttsStartTs: number | null;
  ttsEndTs: number | null;
  transcript: string;
  response: string;
}

// Latency statistics
export interface LatencyStats {
  turns: number;
  stt: number[];
  agent: number[];
  tts: number[];
  total: number[];
}

// Activity feed item
export interface ActivityItem {
  id: string;
  type: "stt" | "agent" | "tts" | "tool";
  label: string;
  text: string;
  args?: Record<string, unknown>;
  timestamp: Date;
}

// Console log entry
export interface LogEntry {
  id: string;
  message: string;
  timestamp: Date;
}
