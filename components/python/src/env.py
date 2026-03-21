import os

OPENAI_RESPONSE_LANGUAGE = os.getenv("OPENAI_RESPONSE_LANGUAGE", "en")

# Graph models
OPENAI_CLASSIFIER_MODEL = os.getenv("OPENAI_CLASSIFIER_MODEL", "gpt-4o-mini")
OPENAI_FAST_MODEL = os.getenv("OPENAI_FAST_MODEL", "gpt-4o-mini")
OPENAI_SLOW_MODEL = os.getenv("OPENAI_SLOW_MODEL", "gpt-4o-mini")

# Realtime transport models (used by main.py)
OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-4o-mini-realtime-preview")
OPENAI_STT_MODEL = os.getenv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe")
OPENAI_STT_LANGUAGE = os.getenv("OPENAI_STT_LANGUAGE", OPENAI_RESPONSE_LANGUAGE)
OPENAI_VAD_THRESHOLD = float(os.getenv("OPENAI_VAD_THRESHOLD", "0.5"))
OPENAI_VAD_PREFIX_PADDING_MS = int(os.getenv("OPENAI_VAD_PREFIX_PADDING_MS", "300"))
OPENAI_VAD_SILENCE_DURATION_MS = int(os.getenv("OPENAI_VAD_SILENCE_DURATION_MS", "1200"))
OPENAI_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "alloy")
OPENAI_TTS_LANGUAGE = os.getenv("OPENAI_TTS_LANGUAGE", OPENAI_RESPONSE_LANGUAGE)
OPENAI_TTS_RENDER_PROMPT_TEMPLATE = os.getenv(
    "OPENAI_TTS_RENDER_PROMPT_TEMPLATE",
    "Read the following text in {language}. Do not add anything else: {text}",
)

# General graph texts
INPUT_CLASSIFIER_TIMEOUT_SECONDS = int(os.getenv("INPUT_CLASSIFIER_TIMEOUT_SECONDS", "10"))
TASK_INACTIVITY_TIMEOUT_SECONDS = int(os.getenv("TASK_INACTIVITY_TIMEOUT_SECONDS", "45"))
SLOW_TOOL_SLEEP_SECONDS = int(os.getenv("SLOW_TOOL_SLEEP_SECONDS", "10"))
TOPIC_DETAILS_MAX_ITEMS = int(os.getenv("TOPIC_DETAILS_MAX_ITEMS", "30"))
INPUT_POST_TIMEOUT_TEXT = os.getenv(
    "INPUT_POST_TIMEOUT_TEXT",
    "Please wait a moment, I seem to be a bit stuck.",
)
OPENAI_TOOL_CALL_STATUS_TEXT = os.getenv(
    "OPENAI_TOOL_CALL_STATUS_TEXT",
    "I am using tools to gather information. Please wait.",
)

# Prompts
INPUT_CLASSIFIER_PROMPT_TEMPLATE = os.getenv(
    "INPUT_CLASSIFIER_PROMPT_TEMPLATE",
    (
        "You are a task classifier for a voice agent. "
        "Given the latest user input and existing tasks, return strict JSON with keys: "
        "is_new_task (bool), task_id (int|null), task_name (str), task_description (str), "
        "topic_id (int|null), needs_slow_responder (bool), latest_input (str). "
        "Pick an existing task id if user input belongs to one. "
        "Set needs_slow_responder=true when user asks for deep, careful, detailed, step-by-step, "
        "serious, rigorous, comprehensive, planning, analysis, or long-horizon work. "
        "Examples include phrases like: '认真', '详细', '深入', '系统地', '一步一步', '完整方案', "
        "'carefully', 'in detail', 'step by step', 'comprehensive plan'. "
        "For short/simple requests, set needs_slow_responder=false. "
        "Use concise values."
    ),
)
FAST_RESPONDER_PROMPT_TEMPLATE = os.getenv(
    "FAST_RESPONDER_PROMPT_TEMPLATE",
    (
        "You are a fast responder. "
        "Return STRICT JSON with keys: voice_output (string), detailed_output (string). "
        "voice_output must be exactly one sentence for TTS playback. "
        "Put all additional explanations, context, caveats, and tool details into detailed_output. "
        "Do not output any text outside JSON."
    ),
)
SLOW_RESPONDER_PLAN_PROMPT_TEMPLATE = os.getenv(
    "SLOW_RESPONDER_PLAN_PROMPT_TEMPLATE",
    (
        "You are a slow planner. Produce a compact multi-step plan to solve the task. "
        "Return plain text with numbered steps."
    ),
)
SLOW_FINALIZER_PROMPT_TEMPLATE = os.getenv(
    "SLOW_FINALIZER_PROMPT_TEMPLATE",
    (
        "You are the slow responder finalizer. "
        "Return STRICT JSON with keys: voice_output (string), detailed_output (string). "
        "voice_output must be exactly one sentence for TTS playback. "
        "Put all deeper analysis and supporting details into detailed_output. "
        "Do not output planning steps verbatim and do not include internal tags like [slow_tool]. "
        "Do not output any text outside JSON."
    ),
)
SLOW_FINALIZER_FALLBACK_TEXT = os.getenv(
    "SLOW_FINALIZER_FALLBACK_TEXT",
    "I have completed the deeper analysis and prepared the final result.",
)
TOPIC_SUMMARY_PROMPT_TEMPLATE = os.getenv(
    "TOPIC_SUMMARY_PROMPT_TEMPLATE",
    (
        "Update topic memory summary using the closed task details. "
        "Keep summary short, factual, and incremental."
    ),
)

