import asyncio
import json
import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
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

try:
    from env import (
        FAST_RESPONDER_PROMPT_TEMPLATE,
        INPUT_CLASSIFIER_PROMPT_TEMPLATE,
        INPUT_CLASSIFIER_TIMEOUT_SECONDS,
        INPUT_POST_TIMEOUT_TEXT,
        OPENAI_CLASSIFIER_MODEL,
        OPENAI_FAST_MODEL,
        OPENAI_SLOW_MODEL,
        OPENAI_TOOL_CALL_STATUS_TEXT,
        SLOW_FINALIZER_PROMPT_TEMPLATE,
        SLOW_FINALIZER_FALLBACK_TEXT,
        SLOW_RESPONDER_PLAN_PROMPT_TEMPLATE,
        SLOW_TOOL_SLEEP_SECONDS,
        TASK_INACTIVITY_TIMEOUT_SECONDS,
    TOPIC_DETAILS_MAX_ITEMS,
        TOPIC_SUMMARY_PROMPT_TEMPLATE,
    )
except ModuleNotFoundError:  # pragma: no cover - package-style import fallback
    from src.env import (
        FAST_RESPONDER_PROMPT_TEMPLATE,
        INPUT_CLASSIFIER_PROMPT_TEMPLATE,
        INPUT_CLASSIFIER_TIMEOUT_SECONDS,
        INPUT_POST_TIMEOUT_TEXT,
        OPENAI_CLASSIFIER_MODEL,
        OPENAI_FAST_MODEL,
        OPENAI_SLOW_MODEL,
        OPENAI_TOOL_CALL_STATUS_TEXT,
        SLOW_FINALIZER_PROMPT_TEMPLATE,
        SLOW_FINALIZER_FALLBACK_TEXT,
        SLOW_RESPONDER_PLAN_PROMPT_TEMPLATE,
        SLOW_TOOL_SLEEP_SECONDS,
        TASK_INACTIVITY_TIMEOUT_SECONDS,
        TOPIC_DETAILS_MAX_ITEMS,
        TOPIC_SUMMARY_PROMPT_TEMPLATE,
    )

LOGGER = logging.getLogger("uvicorn.error")


class VoiceAgentState(TypedDict, total=False):
    TaskIdCounter: int
    TopicIdCounter: int


def _task_key(task_id: int, suffix: str) -> str:
    return f"task{task_id}_{suffix}"


def _topic_key(topic_id: int) -> str:
    return f"topicId_{topic_id}"


def _topic_details_key(topic_id: int) -> str:
    return f"topicId_{topic_id}_details"


def _parse_wait_result(wait_result: Any) -> tuple[bool, dict[str, list[Any]]]:
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


def _safe_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return {}
    try:
        return json.loads(match.group(0))
    except Exception:
        return {}


def _extract_voice_detail_payload(text: str) -> tuple[str, str]:
    payload = _extract_json(text)
    if not payload:
        return text.strip(), ""
    voice = str(payload.get("voice_output") or "").strip()
    detail = str(payload.get("detailed_output") or "").strip()
    if not voice and isinstance(payload.get("voice"), str):
        voice = str(payload.get("voice") or "").strip()
    if not detail and isinstance(payload.get("detail"), str):
        detail = str(payload.get("detail") or "").strip()
    return voice, detail


def _mock_fast_tools(task_id: int, latest_input: str) -> list[str]:
    output = [f"[fast_tool] task={task_id} quick_lookup completed"]
    if "weather" in latest_input.lower() or "天气" in latest_input:
        output.append("[fast_tool] weather probe: mock 24C and partly cloudy")
    return output


async def _mock_slow_tool(task_id: int, plan_step: str) -> str:
    await asyncio.sleep(SLOW_TOOL_SLEEP_SECONDS)
    return f"[slow_tool] task={task_id} executed: {plan_step}"


def _build_llm(model: str) -> ChatOpenAI:
    return ChatOpenAI(model=model, temperature=0)


def build_voice_graph():
    classifier_llm = _build_llm(OPENAI_CLASSIFIER_MODEL)
    fast_llm = _build_llm(OPENAI_FAST_MODEL)
    slow_llm = _build_llm(OPENAI_SLOW_MODEL)

    async def init_node(state: VoiceAgentState) -> Command:
        state["TaskIdCounter"] = int(state.get("TaskIdCounter") or 0)
        state["TopicIdCounter"] = int(state.get("TopicIdCounter") or 0)
        LOGGER.info(
            "[saf-graph] init_node counters task=%s topic=%s",
            state["TaskIdCounter"],
            state["TopicIdCounter"],
        )
        return Command(
            update=state,
            goto=[
                Send(input_receiver, None),
                Send(topic_memory_merger, None),
            ],
        )

    async def input_receiver(ctx: Context, state: VoiceAgentState) -> Command:
        wait_result = await ctx.wait_for(channel_condition("user_input", min=1, max=100))
        _, channel_batches = _parse_wait_result(wait_result)
        user_inputs = [str(v).strip() for v in channel_batches.get("user_input", []) if str(v).strip()]
        LOGGER.info("[saf-graph] input_receiver got user_input count=%s", len(user_inputs))
        sends: list[Send] = [Send(input_receiver, None)]
        
        if user_inputs:
            sends.extend(Send(input_classifier, text) for text in user_inputs)
            sends.append(Send(input_post_classifier, None))
        else:
            raise RuntimeError("No user input received")
        return Command(update=state, goto=sends)

    async def input_classifier(ctx: Context, user_input: str, state: VoiceAgentState) -> None:
        LOGGER.info("[saf-graph] input_classifier input=%s", user_input)
        task_counter = int(state.get("TaskIdCounter") or 0)
        topic_counter = int(state.get("TopicIdCounter") or 0)
        existing_tasks: list[dict[str, Any]] = []
        for task_id in range(1, task_counter + 1):
            name = state.get(_task_key(task_id, "name"))
            description = state.get(_task_key(task_id, "description"))
            if name is None and description is None:
                continue
            existing_tasks.append(
                {
                    "task_id": task_id,
                    "name": name,
                    "description": description,
                    "topic_id": state.get(_task_key(task_id, "topic_id")),
                }
            )
        existing_topics: list[dict[str, Any]] = []
        for topic_id in range(1, topic_counter + 1):
            summary = state.get(_topic_key(topic_id))
            if summary is None:
                continue
            existing_topics.append(
                {
                    "topic_id": topic_id,
                    "summary": str(summary),
                }
            )

        classifier_input = {
            "latest_user_input": user_input,
            "existing_tasks": existing_tasks,
            "existing_topics": existing_topics,
            "required_json_schema": {
                "is_new_task": "bool",
                "task_id": "int|null",
                "task_name": "str",
                "task_description": "str",
                "topic_id": "int|null",
                "needs_slow_responder": "bool",
                "latest_input": "str",
            },
        }
        response = await classifier_llm.ainvoke(
            [
                SystemMessage(content=INPUT_CLASSIFIER_PROMPT_TEMPLATE),
                HumanMessage(content=json.dumps(classifier_input, ensure_ascii=False)),
            ]
        )
        raw = response.text if hasattr(response, "text") else str(response.content or "")
        parsed = _extract_json(raw)

        is_new = bool(parsed.get("is_new_task", True))
        task_id_value = parsed.get("task_id")
        task_id = int(task_id_value) if isinstance(task_id_value, int) else None
        topic_id_value = parsed.get("topic_id")
        topic_id = int(topic_id_value) if isinstance(topic_id_value, int) else None
        classification = {
            "is_new_task": is_new,
            "task_id": task_id,
            "task_name": str(parsed.get("task_name") or "General task"),
            "task_description": str(parsed.get("task_description") or user_input),
            "topic_id": topic_id,
            "needs_slow_responder": bool(parsed.get("needs_slow_responder", False)),
            "latest_input": str(parsed.get("latest_input") or user_input),
        }
        LOGGER.info("[saf-graph] input_classifier output=%s", classification)
        ctx.publish_to_channel("user_input_classification", classification)

    async def input_post_classifier(ctx: Context, state: VoiceAgentState) -> Command:
        wait_result = await ctx.wait_for(
            any_of(
                channel_condition("user_input_classification", min=1, max=100),
                timer_condition(seconds=INPUT_CLASSIFIER_TIMEOUT_SECONDS),
            )
        )
        timer_fired, channel_batches = _parse_wait_result(wait_result)
        LOGGER.info(
            "[saf-graph] input_post_classifier wake timer=%s cls_count=%s",
            timer_fired,
            len(channel_batches.get("user_input_classification", [])),
        )
        if timer_fired and not channel_batches:
            ctx.send_custom_stream_event(
                "voice_output_stream",
                {
                    "text": INPUT_POST_TIMEOUT_TEXT,
                    "task_id": None,
                    "ts": int(time.time() * 1000),
                }
            )
            return Command(update=state, goto=Send(input_post_classifier, None))

        sends: list[Send] = []
        for item in channel_batches.get("user_input_classification", []):
            if not isinstance(item, dict):
                continue
            requested_task_id = item.get("task_id")
            task_id = int(requested_task_id) if isinstance(requested_task_id, int) else 0
            is_new_task = bool(item.get("is_new_task", True))
            if task_id <= 0 or task_id > int(state.get("TaskIdCounter") or 0):
                is_new_task = True

            if is_new_task:
                task_id = int(state.get("TaskIdCounter") or 0) + 1
                state["TaskIdCounter"] = task_id
                state[_task_key(task_id, "name")] = str(item.get("task_name") or f"Task {task_id}")
                state[_task_key(task_id, "description")] = str(
                    item.get("task_description") or "No description"
                )
                state[_task_key(task_id, "user_inputs")] = []
                state[_task_key(task_id, "user_quick_outputs")] = []
                state[_task_key(task_id, "user_slow_outputs")] = []
                if item.get("topic_id") is not None:
                    state[_task_key(task_id, "topic_id")] = int(item["topic_id"])

                sends.extend(
                    [
                        Send(fast_responder, task_id),
                        Send(slow_responder, task_id),
                        Send(task_inactivity_timeouter, task_id),
                    ]
                )
                LOGGER.info("[saf-graph] input_post_classifier created task_id=%s", task_id)

            user_inputs = _safe_list(state.get(_task_key(task_id, "user_inputs")))
            latest_input = str(item.get("latest_input") or "").strip()
            if latest_input:
                user_inputs.append(latest_input)
            state[_task_key(task_id, "user_inputs")] = user_inputs

            if item.get("topic_id") is not None:
                state[_task_key(task_id, "topic_id")] = int(item["topic_id"])

            ctx.publish_to_channel(f"fast_responder_trigger_{task_id}", True)
            if bool(item.get("needs_slow_responder", False)):
                ctx.publish_to_channel(f"slow_responder_trigger_{task_id}", True)
            ctx.publish_to_channel(f"task_activity_{task_id}", True)
            LOGGER.info(
                "[saf-graph] input_post_classifier trigger task_id=%s slow=%s",
                task_id,
                bool(item.get("needs_slow_responder", False)),
            )

        return Command(update=state, goto=sends) if sends else Command(update=state)

    async def fast_responder(ctx: Context, task_id: int) -> Command | None:
        LOGGER.info("[saf-graph] fast_responder wait task_id=%s", task_id)
        wait_result = await ctx.wait_for(
            any_of(
                channel_condition(f"fast_responder_trigger_{task_id}", min=1, max=100),
                channel_condition(f"fast_responder_done_{task_id}", min=1, max=1),
            )
        )
        _, channel_batches = _parse_wait_result(wait_result)
        LOGGER.info(
            "[saf-graph] fast_responder wake task_id=%s trigger=%s done=%s",
            task_id,
            bool(channel_batches.get(f"fast_responder_trigger_{task_id}")),
            bool(channel_batches.get(f"fast_responder_done_{task_id}")),
        )
        if channel_batches.get(f"fast_responder_done_{task_id}"):
            return None
        if channel_batches.get(f"fast_responder_trigger_{task_id}"):
            return Command(goto=Send(fast_respond_llm, task_id))
        return Command(goto=Send(fast_responder, task_id))

    async def fast_respond_llm(ctx: Context, task_id: int, state: VoiceAgentState) -> Command:
        LOGGER.info("[saf-graph] fast_respond_llm start task_id=%s", task_id)
        user_inputs = _safe_list(state.get(_task_key(task_id, "user_inputs")))
        quick_outputs = _safe_list(state.get(_task_key(task_id, "user_quick_outputs")))
        latest_input = user_inputs[-1] if user_inputs else ""
        tool_outputs = _mock_fast_tools(task_id, latest_input)
        response = await fast_llm.ainvoke(
            [
                SystemMessage(content=FAST_RESPONDER_PROMPT_TEMPLATE),
                HumanMessage(
                    content=json.dumps(
                        {
                            "task_id": task_id,
                            "task_name": state.get(_task_key(task_id, "name")),
                            "task_description": state.get(_task_key(task_id, "description")),
                            "user_inputs": user_inputs[-10:],
                            "previous_quick_outputs": quick_outputs[-5:],
                            "fast_tool_results": tool_outputs,
                        },
                        ensure_ascii=False,
                    )
                ),
            ]
        )
        ai_text = (response.text if hasattr(response, "text") else str(response.content or "")).strip()
        voice_text, detail_text = _extract_voice_detail_payload(ai_text)
        if not voice_text:
            voice_text = OPENAI_TOOL_CALL_STATUS_TEXT
        if tool_outputs:
            tool_detail = "\n".join(tool_outputs)
            detail_text = f"{detail_text}\n{tool_detail}".strip() if detail_text else tool_detail

        composed_output = (
            f"{voice_text}\n{detail_text}".strip() if detail_text else voice_text
        ).strip()
        LOGGER.info(
            "[saf-graph] fast_respond_llm text task_id=%s voice=%s detail=%s",
            task_id,
            voice_text,
            detail_text,
        )

        quick_outputs.append(composed_output)
        state[_task_key(task_id, "user_quick_outputs")] = quick_outputs
        if voice_text:
            ctx.send_custom_stream_event(
                "voice_output_stream",
                {
                    "task_id": task_id,
                    "text": voice_text,
                    "ts": int(time.time() * 1000),
                }
            )
        if detail_text:
            ctx.send_custom_stream_event(
                "detailed_output_stream",
                {
                    "task_id": task_id,
                    "text": detail_text,
                    "ts": int(time.time() * 1000),
                }
            )
        return Command(update=state, goto=Send(fast_responder, task_id))

    async def slow_responder(ctx: Context, task_id: int) -> Command | None:
        LOGGER.info("[saf-graph] slow_responder wait task_id=%s", task_id)
        wait_result = await ctx.wait_for(
            any_of(
                channel_condition(f"slow_responder_trigger_{task_id}", min=1, max=100),
                channel_condition(f"slow_responder_done_{task_id}", min=1, max=1),
            )
        )
        _, channel_batches = _parse_wait_result(wait_result)
        LOGGER.info(
            "[saf-graph] slow_responder wake task_id=%s trigger=%s done=%s",
            task_id,
            bool(channel_batches.get(f"slow_responder_trigger_{task_id}")),
            bool(channel_batches.get(f"slow_responder_done_{task_id}")),
        )
        if channel_batches.get(f"slow_responder_done_{task_id}"):
            return None
        if channel_batches.get(f"slow_responder_trigger_{task_id}"):
            return Command(goto=Send(slow_respond_llm, task_id))
        return Command(goto=Send(slow_responder, task_id))

    async def slow_respond_llm(ctx: Context, task_id: int, state: VoiceAgentState) -> Command:
        LOGGER.info("[saf-graph] slow_respond_llm start task_id=%s", task_id)
        user_inputs = _safe_list(state.get(_task_key(task_id, "user_inputs")))
        slow_outputs = _safe_list(state.get(_task_key(task_id, "user_slow_outputs")))
        response = await slow_llm.ainvoke(
            [
                SystemMessage(content=SLOW_RESPONDER_PLAN_PROMPT_TEMPLATE),
                HumanMessage(
                    content=json.dumps(
                        {
                            "task_id": task_id,
                            "task_name": state.get(_task_key(task_id, "name")),
                            "task_description": state.get(_task_key(task_id, "description")),
                            "user_inputs": user_inputs[-20:],
                            "previous_slow_outputs": slow_outputs[-10:],
                        },
                        ensure_ascii=False,
                    )
                ),
            ]
        )
        plan = (response.text if hasattr(response, "text") else str(response.content or "")).strip()
        if not plan:
            plan = "1. Gather more detail.\n2. Execute the plan.\n3. Return result."
        LOGGER.info("[saf-graph] slow_respond_llm plan task_id=%s plan=%s", task_id, plan)

        ctx.send_custom_stream_event(
            "detailed_output_stream",
            {
                "task_id": task_id,
                "text": plan,
                "ts": int(time.time() * 1000),
            }
        )
        return Command(
            update=state,
            goto=Send(slow_plan_executor, {"task_id": task_id, "plan": plan, "step": 1}),
        )

    async def slow_plan_executor(
        ctx: Context, payload: dict[str, Any], state: VoiceAgentState
    ) -> Command:
        task_id = int(payload.get("task_id", 0))
        step = int(payload.get("step", 1))
        plan = str(payload.get("plan", "")).strip() or "No plan"
        LOGGER.info("[saf-graph] slow_plan_executor task_id=%s step=%s", task_id, step)

        if step <= 2:
            progress = f"Executing slow plan step {step}/2 for task {task_id}..."
            ctx.send_custom_stream_event(
                "detailed_output_stream",
                {
                    "task_id": task_id,
                    "text": progress,
                    "ts": int(time.time() * 1000),
                }
            )
            await asyncio.sleep(1)
            return Command(
                update=state,
                goto=Send(
                    slow_plan_executor,
                    {"task_id": task_id, "plan": plan, "step": step + 1},
                ),
            )

        slow_result = await _mock_slow_tool(task_id, "multi-step plan execution completed")
        user_inputs = _safe_list(state.get(_task_key(task_id, "user_inputs")))
        final_response = await slow_llm.ainvoke(
            [
                SystemMessage(
                    content=SLOW_FINALIZER_PROMPT_TEMPLATE
                ),
                HumanMessage(
                    content=json.dumps(
                        {
                            "task_id": task_id,
                            "task_name": state.get(_task_key(task_id, "name")),
                            "task_description": state.get(_task_key(task_id, "description")),
                            "latest_user_input": user_inputs[-1] if user_inputs else "",
                            "plan": plan,
                            "slow_tool_result": slow_result,
                        },
                        ensure_ascii=False,
                    )
                ),
            ]
        )
        final_answer = (
            final_response.text
            if hasattr(final_response, "text")
            else str(final_response.content or "")
        ).strip()
        if not final_answer:
            final_answer = SLOW_FINALIZER_FALLBACK_TEXT
        voice_text, detail_text = _extract_voice_detail_payload(final_answer)
        if not voice_text:
            voice_text = SLOW_FINALIZER_FALLBACK_TEXT
        slow_outputs = _safe_list(state.get(_task_key(task_id, "user_slow_outputs")))
        composed_output = (
            f"{voice_text}\n{detail_text}".strip() if detail_text else voice_text
        ).strip()
        slow_outputs.append(composed_output)
        state[_task_key(task_id, "user_slow_outputs")] = slow_outputs
        ctx.send_custom_stream_event(
            "voice_output_stream",
            {
                "task_id": task_id,
                "text": voice_text,
                "ts": int(time.time() * 1000),
            }
        )
        if detail_text:
            ctx.send_custom_stream_event(
                "detailed_output_stream",
                {
                    "task_id": task_id,
                    "text": detail_text,
                    "ts": int(time.time() * 1000),
                }
            )
        return Command(update=state, goto=Send(slow_responder, task_id))

    async def task_inactivity_timeouter(ctx: Context, task_id: int) -> Command | None:
        LOGGER.info("[saf-graph] task_inactivity_timeouter wait task_id=%s", task_id)
        wait_result = await ctx.wait_for(
            any_of(
                channel_condition(f"task_activity_{task_id}", min=1, max=100),
                timer_condition(seconds=TASK_INACTIVITY_TIMEOUT_SECONDS),
            )
        )
        timer_fired, channel_batches = _parse_wait_result(wait_result)
        LOGGER.info(
            "[saf-graph] task_inactivity_timeouter wake task_id=%s timer=%s activity=%s",
            task_id,
            timer_fired,
            bool(channel_batches.get(f"task_activity_{task_id}")),
        )
        if channel_batches.get(f"task_activity_{task_id}"):
            return Command(goto=Send(task_inactivity_timeouter, task_id))
        if timer_fired:
            ctx.publish_to_channel(f"fast_responder_done_{task_id}", True)
            ctx.publish_to_channel(f"slow_responder_done_{task_id}", True)
            ctx.publish_to_channel("task_done", task_id)
            return None
        return Command(goto=Send(task_inactivity_timeouter, task_id))

    async def topic_memory_merger(ctx: Context, state: VoiceAgentState) -> Command:
        wait_result = await ctx.wait_for(channel_condition("task_done", min=1, max=100))
        _, channel_batches = _parse_wait_result(wait_result)
        LOGGER.info(
            "[saf-graph] topic_memory_merger task_done_count=%s",
            len(channel_batches.get("task_done", [])),
        )

        for value in channel_batches.get("task_done", []):
            task_id = int(value)
            name = str(state.get(_task_key(task_id, "name")) or "")
            description = str(state.get(_task_key(task_id, "description")) or "")
            user_inputs = _safe_list(state.get(_task_key(task_id, "user_inputs")))
            quick_outputs = _safe_list(state.get(_task_key(task_id, "user_quick_outputs")))
            slow_outputs = _safe_list(state.get(_task_key(task_id, "user_slow_outputs")))

            topic_id_value = state.get(_task_key(task_id, "topic_id"))
            if isinstance(topic_id_value, int):
                topic_id = topic_id_value
            else:
                topic_id = int(state.get("TopicIdCounter") or 0) + 1
                state["TopicIdCounter"] = topic_id
                state[_task_key(task_id, "topic_id")] = topic_id

            topic_key = _topic_key(topic_id)
            topic_details_key = _topic_details_key(topic_id)
            old_summary = str(state.get(topic_key) or "")
            summary_input = {
                "instruction": TOPIC_SUMMARY_PROMPT_TEMPLATE,
                "existing_topic_summary": old_summary,
                "task": {
                    "task_id": task_id,
                    "name": name,
                    "description": description,
                    "user_inputs": user_inputs[-20:],
                    "quick_outputs": quick_outputs[-10:],
                    "slow_outputs": slow_outputs[-10:],
                },
            }
            merged_response = await slow_llm.ainvoke(
                [HumanMessage(content=json.dumps(summary_input, ensure_ascii=False))]
            )
            merged_summary = (
                merged_response.text
                if hasattr(merged_response, "text")
                else str(merged_response.content or "")
            ).strip()
            if not merged_summary:
                merged_summary = old_summary
            state[topic_key] = merged_summary
            topic_details = state.get(topic_details_key)
            if not isinstance(topic_details, list):
                topic_details = []
            topic_details.append(
                {
                    "task_id": task_id,
                    "name": name,
                    "description": description,
                    "user_inputs": user_inputs[-20:],
                    "quick_outputs": quick_outputs[-10:],
                    "slow_outputs": slow_outputs[-10:],
                    "merged_at_ts": int(time.time() * 1000),
                }
            )
            state[topic_details_key] = topic_details[-TOPIC_DETAILS_MAX_ITEMS:]

            # Tombstones to prevent unbounded growth.
            state[_task_key(task_id, "name")] = None
            state[_task_key(task_id, "description")] = None
            state[_task_key(task_id, "user_inputs")] = None
            state[_task_key(task_id, "user_quick_outputs")] = None
            state[_task_key(task_id, "user_slow_outputs")] = None
            state[_task_key(task_id, "topic_id")] = None

        return Command(update=state, goto=Send(topic_memory_merger, None))

    graph = AdvancedStateGraph(VoiceAgentState)
    graph.add_custom_output_stream("voice_output_stream", dict)
    graph.add_custom_output_stream("detailed_output_stream", dict)
    graph.add_async_channel("user_input", str)
    graph.add_async_channel("user_input_classification", dict)
    graph.add_async_channel("task_done", int)
    graph.define_async_channels_by_prefix("fast_responder_done_", bool)
    graph.define_async_channels_by_prefix("slow_responder_done_", bool)
    graph.define_async_channels_by_prefix("fast_responder_trigger_", bool)
    graph.define_async_channels_by_prefix("slow_responder_trigger_", bool)
    graph.define_async_channels_by_prefix("task_activity_", bool)

    graph.add_entry_node(init_node)
    graph.add_node(input_receiver)
    graph.add_node(input_classifier)
    graph.add_node(input_post_classifier)
    graph.add_node(fast_responder)
    graph.add_node(fast_respond_llm)
    graph.add_node(slow_responder)
    graph.add_node(slow_respond_llm)
    graph.add_node(slow_plan_executor)
    graph.add_node(task_inactivity_timeouter)
    graph.add_node(topic_memory_merger)
    return graph.compile()
