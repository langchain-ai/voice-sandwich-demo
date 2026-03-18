import json
import logging
import os
import time
from typing import Any

from duckduckgo_search import DDGS
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from saf_python_sdk.advanced_graph import (
    AdvancedStateGraph,
    Context,
    any_of,
    channel_condition,
    timer_condition,
)
from saf_python_sdk.types import Command, Send
from typing_extensions import TypedDict

LOGGER = logging.getLogger("uvicorn.error")
OPENAI_RESPONSE_LANGUAGE = os.getenv("OPENAI_RESPONSE_LANGUAGE", "en")
OPENAI_ASSISTANT_SYSTEM_PROMPT = os.getenv(
    "OPENAI_ASSISTANT_SYSTEM_PROMPT",
    (
        f"You are a concise assistant. Reply in {OPENAI_RESPONSE_LANGUAGE}. "
        "Use tools when helpful, and incorporate tool results in your answer."
    ),
)
OPENAI_RESPONSE_LENGTH_PROMPT = os.getenv(
    "OPENAI_RESPONSE_LENGTH_PROMPT",
    "Keep every reply short: no more than 3 sentences.",
)
OPENAI_AVOID_REPEAT_PROMPT = os.getenv(
    "OPENAI_AVOID_REPEAT_PROMPT",
    "Do not repeat prior assistant responses. If information was already provided, do not repeat it.",
)
OPENAI_TIMER_TEXT = os.getenv("OPENAI_TIMER_TEXT", "I am here. What can I do for you?")
GET_WEATHER_TEMPLATE = os.getenv(
    "GET_WEATHER_TEMPLATE",
    "Weather for {location}: 24C, partly cloudy.",
)
INTERNET_SEARCH_TEMPLATE = os.getenv(
    "INTERNET_SEARCH_TEMPLATE",
    "Internet search results for '{query}':\n{results}",
)
INTERNET_SEARCH_MAX_RESULTS = int(os.getenv("INTERNET_SEARCH_MAX_RESULTS", "5"))


class VoiceGraphState(TypedDict):
    user_messages: list[str]
    tool_completion_results: list[str]
    llm_messages: list[str]


@tool("GetWeather")
def get_weather(location: str) -> str:
    """Get weather information for a location."""
    return GET_WEATHER_TEMPLATE.format(location=location)


@tool("InternetSearch")
def internet_search(query: str) -> str:
    """Search internet and return a short summary."""
    results: list[str] = []
    try:
        with DDGS() as ddgs:
            search_results = ddgs.text(query, max_results=INTERNET_SEARCH_MAX_RESULTS)
            for item in search_results:
                title = (item.get("title") or "").strip()
                snippet = (item.get("body") or "").strip()
                href = (item.get("href") or "").strip()
                line = " | ".join(part for part in [title, snippet, href] if part)
                if line:
                    results.append(line)
    except Exception as exc:  # pragma: no cover - network/provider issues
        return f"Internet search failed for '{query}': {exc}"

    if not results:
        return f"No search results found for '{query}'."

    joined = "\n".join(f"{idx + 1}. {line}" for idx, line in enumerate(results))
    return INTERNET_SEARCH_TEMPLATE.format(query=query, results=joined)


TOOLS = [get_weather, internet_search]
TOOLS_BY_NAME = {
    "GetWeather": get_weather,
    "InternetSearch": internet_search,
    "Internet Search": internet_search,
}


def _build_llm(bind_tools: bool) -> ChatOpenAI:
    model_name = os.getenv("OPENAI_LLM_MODEL", "gpt-4o-mini")
    llm = ChatOpenAI(model=model_name, temperature=0)
    return llm.bind_tools(TOOLS) if bind_tools else llm


def build_voice_graph():
    llm_with_tools = _build_llm(bind_tools=True)

    def parse_wait_result(wait_result: Any) -> tuple[bool, dict[str, list[Any]]]:
        timer_fired = False
        channel_batches: dict[str, list[Any]] = {}
        for condition in getattr(wait_result, "conditions", []):
            if not getattr(condition, "met", False):
                continue
            channel_name = getattr(condition, "channel_name", None)
            if channel_name is None:
                timer_fired = True
                continue
            values = getattr(condition, "values", None) or []
            channel_batches[channel_name] = [*channel_batches.get(channel_name, []), *values]
        return timer_fired, channel_batches

    async def start_node(state: VoiceGraphState) -> Command:
        return Command(goto=Send("llm_node", None))

    async def llm_node(ctx: Context, state: VoiceGraphState) -> Command:
        LOGGER.info("[saf-graph] llm_node wake: state=%s", state)

        wait_result = await ctx.wait_for(
            any_of(
                channel_condition("user_buffered_message", min=1, max=100),
                channel_condition("tool_call_results", min=1, max=100),
                timer_condition(seconds=30),
            )
        )

        timer_fired, channel_batches = parse_wait_result(wait_result)
        LOGGER.info(
            "[saf-graph] llm_node wake: timer_fired=%s user_msgs=%s tool_results=%s",
            timer_fired,
            len(channel_batches.get("user_buffered_message", [])),
            len(channel_batches.get("tool_call_results", [])),
        )

        if timer_fired and not channel_batches:
            timer_text = OPENAI_TIMER_TEXT
            state["llm_messages"].append(timer_text)
            ctx.send_custom_stream_event(
                {
                    "type": "ai_text",
                    "who": "AI",
                    "text": timer_text,
                    "ts": int(time.time() * 1000),
                }
            )
            return Command(update=state, goto=Send("llm_node", None))

        for value in channel_batches.get("user_buffered_message", []):
            state["user_messages"].append(str(value))
        for value in channel_batches.get("tool_call_results", []):
            state["tool_completion_results"].append(str(value))

        if not channel_batches:
            LOGGER.info("[saf-graph] llm_node no channels met; continue waiting")
            return Command(update=state, goto=Send("llm_node", None))

        recent_user_messages = state["user_messages"][-50:]
        recent_tool_results = state["tool_completion_results"][-10:]
        recent_ai_messages = state["llm_messages"][-20:]
        prompt_messages = [
            SystemMessage(content=OPENAI_ASSISTANT_SYSTEM_PROMPT),
            SystemMessage(content=OPENAI_RESPONSE_LENGTH_PROMPT),
            SystemMessage(content=OPENAI_AVOID_REPEAT_PROMPT),
        ]
        prompt_messages.extend(
            HumanMessage(content=text) for text in recent_user_messages if text.strip()
        )
        prompt_messages.extend(
            AIMessage(content=text) for text in recent_ai_messages if text.strip()
        )
        prompt_messages.extend(
            SystemMessage(content=f"Tool completion result #{idx + 1}: {text}")
            for idx, text in enumerate(recent_tool_results)
            if text.strip()
        )

        ai_message = await llm_with_tools.ainvoke(prompt_messages)

        response_text = (
            ai_message.text if hasattr(ai_message, "text") else str(ai_message.content or "")
        )
        if response_text.strip():
            normalized = response_text.strip()
            LOGGER.info("[saf-graph] llm_node response: %s", normalized)
            state["llm_messages"].append(normalized)
            ctx.send_custom_stream_event(
                {
                    "type": "ai_text",
                    "who": "AI",
                    "text": normalized,
                    "ts": int(time.time() * 1000),
                }
            )

        sends: list[Send] = [Send("llm_node", None)]
        tool_calls = list(getattr(ai_message, "tool_calls", []) or [])
        for tool_call in tool_calls:
            sends.append(Send("tool_call_node", tool_call))
        if tool_calls:
            LOGGER.info(
                "[saf-graph] scheduling tool calls: %s",
                [tool_call.get("name", "unknown") for tool_call in tool_calls],
            )

        return Command(update=state, goto=sends)

    async def tool_call_node(ctx: Context, tool_call: dict[str, Any]) -> None:
        tool_name = tool_call.get("name", "")
        tool_args = tool_call.get("args", {}) or {}
        LOGGER.info("[saf-graph] tool_call_node execute: %s args=%s", tool_name, tool_args)
        tool = TOOLS_BY_NAME.get(tool_name)

        if not tool:
            result = f"Unknown tool call: {tool_name}"
        else:
            try:
                result = await tool.ainvoke(tool_args)
            except Exception as exc:  # pragma: no cover - tool runtime failures
                result = f"Tool '{tool_name}' failed: {exc}"

        LOGGER.info("[saf-graph] tool_call_node result: %s", result)
        ctx.publish_to_channel("tool_call_results", str(result))

    graph = AdvancedStateGraph(VoiceGraphState)
    graph.add_async_channel("user_buffered_message", str)
    graph.add_async_channel("tool_call_results", str)
    graph.add_entry_node(start_node)
    graph.add_node(llm_node)
    graph.add_node(tool_call_node)
    return graph.compile()
