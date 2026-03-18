import json
import os
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
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


class VoiceGraphState(TypedDict):
    user_messages: list[str]
    tool_completion_results: list[str]
    llm_messages: list[str]


@tool("GetWeather")
def get_weather(location: str) -> str:
    """Get weather information for a location."""
    return f"Weather for {location}: 24C, partly cloudy."


@tool("InternetSearch")
def internet_search(query: str) -> str:
    """Search internet and return a short summary."""
    return f"Internet search result for '{query}': No live search backend configured."


TOOLS = [get_weather, internet_search]
TOOLS_BY_NAME = {
    "GetWeather": get_weather,
    "InternetSearch": internet_search,
    "Internet Search": internet_search,
}


def _build_llm() -> ChatOpenAI:
    model_name = os.getenv("OPENAI_LLM_MODEL", "gpt-4o-mini")
    return ChatOpenAI(model=model_name, temperature=0).bind_tools(TOOLS)


def build_voice_graph():
    llm = _build_llm()

    async def llm_node(ctx: Context, state: VoiceGraphState) -> Command:
        event = await ctx.wait_for(
            any_of(
                channel_condition("user_buffered_message", min=1, max=100),
                channel_condition("tool_call_results", min=1, max=100),
                timer_condition(seconds=10),
            )
        )

        if event["condition"] == "timer":
            timer_text = "what can I do for you?"
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

        channel = event["channel"]
        raw_values = event["value"]
        values = raw_values if isinstance(raw_values, list) else [raw_values]

        if channel == "user_buffered_message":
            for value in values:
                state["user_messages"].append(str(value))
        elif channel == "tool_call_results":
            for value in values:
                state["tool_completion_results"].append(str(value))

        prompt_context = {
            "recent_user_messages": state["user_messages"][-20:],
            "recent_tool_results": state["tool_completion_results"][-20:],
            "recent_ai_messages": state["llm_messages"][-20:],
        }
        ai_message = await llm.ainvoke(
            [
                SystemMessage(
                    content=(
                        "You are a concise assistant. Use tools when helpful. "
                        "If tool results are available, use them in your response."
                    )
                ),
                HumanMessage(content=json.dumps(prompt_context, ensure_ascii=False)),
            ]
        )

        response_text = (
            ai_message.text()
            if hasattr(ai_message, "text")
            else str(ai_message.content or "")
        )
        if response_text.strip():
            state["llm_messages"].append(response_text.strip())
            ctx.send_custom_stream_event(
                {
                    "type": "ai_text",
                    "who": "AI",
                    "text": response_text.strip(),
                    "ts": int(time.time() * 1000),
                }
            )

        sends: list[Send] = [Send("llm_node", None)]
        for tool_call in getattr(ai_message, "tool_calls", []) or []:
            sends.append(Send("tool_call_node", tool_call))

        return Command(update=state, goto=sends)

    async def tool_call_node(ctx: Context, tool_call: dict[str, Any]) -> None:
        tool_name = tool_call.get("name", "")
        tool_args = tool_call.get("args", {}) or {}
        tool = TOOLS_BY_NAME.get(tool_name)

        if not tool:
            result = f"Unknown tool call: {tool_name}"
        else:
            try:
                result = await tool.ainvoke(tool_args)
            except Exception as exc:  # pragma: no cover - tool runtime failures
                result = f"Tool '{tool_name}' failed: {exc}"

        ctx.publish_to_channel("tool_call_results", str(result))

    graph = AdvancedStateGraph(VoiceGraphState)
    graph.add_async_channel("user_buffered_message", str)
    graph.add_async_channel("tool_call_results", str)
    graph.add_entry_node(llm_node)
    graph.add_node(tool_call_node)
    return graph.compile()
