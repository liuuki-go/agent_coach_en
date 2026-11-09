"""仅选择本次模型调用的输入，不删除 Checkpoint 或业务聊天档案。"""

import logging
from collections.abc import Callable, Sequence
from functools import lru_cache
from typing import Any, Self

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse, wrap_model_call
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage, trim_messages
from langchain_core.messages.utils import count_tokens_approximately
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field, model_validator

from config.config_anasize import get_config_value
from src.domains.error_domain import ChatError


logger = logging.getLogger(__name__)


class ContextBudget(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    context_window_tokens: int = Field(strict=True, gt=0)
    max_output_tokens: int = Field(strict=True, gt=0)
    safety_margin_tokens: int = Field(strict=True, ge=0)
    chars_per_token: float = Field(strict=True, gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def check_input_budget(self) -> Self:
        if self.input_budget_tokens <= 0:
            raise ValueError("上下文窗口必须大于输出预留与安全余量之和")
        return self

    @property
    def input_budget_tokens(self) -> int:
        return self.context_window_tokens - self.max_output_tokens - self.safety_margin_tokens


@lru_cache(maxsize=1)
def get_context_budget() -> ContextBudget:
    config = get_config_value("context_budget")
    if not isinstance(config, dict):
        raise ValueError("context_budget 必须是包含上下文预算的字典")
    return ContextBudget.model_validate(config)


def _validate_tool_messages(messages: Sequence[BaseMessage]) -> None:
    pending: set[str] = set()
    for message in messages:
        if isinstance(message, ToolMessage):
            if message.tool_call_id not in pending:
                raise ChatError("CONTEXT_STATE_INVALID", "上下文工具记录不完整，请新建会话后重试")
            pending.remove(message.tool_call_id)
        else:
            if pending:
                raise ChatError("CONTEXT_STATE_INVALID", "上下文工具记录不完整，请新建会话后重试")
            if isinstance(message, AIMessage) and message.tool_calls:
                for call in message.tool_calls:
                    call_id = call.get("id")
                    if not isinstance(call_id, str) or not call_id or call_id in pending:
                        raise ChatError("CONTEXT_STATE_INVALID", "上下文工具记录不完整，请新建会话后重试")
                    pending.add(call_id)
    if pending:
        raise ChatError("CONTEXT_STATE_INVALID", "上下文工具记录不完整，请新建会话后重试")


def select_context_messages(
    messages: Sequence[BaseMessage],
    *,
    system_message: SystemMessage | None,
    tools: Sequence[BaseTool | dict[str, Any]],
    budget: ContextBudget,
) -> list[BaseMessage]:
    current_start = next(
        (index for index in range(len(messages) - 1, -1, -1) if isinstance(messages[index], HumanMessage)),
        None,
    )
    if current_start is None:
        raise ChatError("CONTEXT_STATE_INVALID", "上下文缺少本轮用户消息，请新建会话后重试")
    history = list(messages[:current_start])
    current = list(messages[current_start:])
    _validate_tool_messages(current)
    system = [system_message] if system_message is not None else []

    def count_with_current(candidate_history: list[BaseMessage]) -> int:
        # system 不在 ModelRequest.messages 中；工具定义与本轮也必须计入总输入预算。
        return count_tokens_approximately(
            [*system, *candidate_history, *current],
            chars_per_token=budget.chars_per_token,
            tools=list(tools),
        )

    before = count_with_current(history)
    required = count_with_current([])
    if required > budget.input_budget_tokens:
        logger.info(
            "context_budget_exceeded estimated_input_tokens_before=%s estimated_required_input_tokens=%s input_budget_tokens=%s history_messages=%s",
            before, required, budget.input_budget_tokens, len(history),
        )
        raise ChatError(
            "CONTEXT_LIMIT_EXCEEDED",
            "当前问题或工具结果超出上下文预算，请缩短内容或新建会话后重试",
        )

    # 当前轮从最后一条 HumanMessage 开始，包含本轮全部工具链，不能被裁剪。
    # start_on 保证历史从完整用户轮次开始，allow_partial=False 保留消息原文。
    selected_history = trim_messages(
        history,
        max_tokens=budget.input_budget_tokens,
        token_counter=count_with_current,
        strategy="last",
        start_on="human",
        allow_partial=False,
    )
    selected = [*selected_history, *current]
    _validate_tool_messages(selected)
    after = count_with_current(selected_history)
    if after > budget.input_budget_tokens:
        raise ChatError(
            "CONTEXT_LIMIT_EXCEEDED",
            "当前问题或工具结果超出上下文预算，请缩短内容或新建会话后重试",
        )
    logger.info(
        "context_budget estimated_input_tokens_before=%s estimated_input_tokens_after=%s input_budget_tokens=%s dropped_messages=%s",
        before, after, budget.input_budget_tokens, len(messages) - len(selected),
    )
    return selected


def create_context_middleware(budget: ContextBudget) -> AgentMiddleware:
    @wrap_model_call(name="context_budget")
    def control_context(
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        selected = select_context_messages(
            request.messages, system_message=request.system_message,
            tools=request.tools, budget=budget,
        )
        # override 返回新调用请求；不对 request.state 或其消息对象写入。
        return handler(request.override(messages=selected))

    return control_context
