
from langchain.agents import create_agent
from collections.abc import Sequence

from src.common.third_party_types import AgentGraph, CheckpointSaver, ToolDefinition

from .template import SYSTEM_PROMPT
from .model_factory import get_model


def build_agent(
    checkpointer: CheckpointSaver | None,
    tools: Sequence[ToolDefinition],
) -> AgentGraph:
    model = get_model()

    return create_agent(
        model=model,
        tools=tools,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=checkpointer,
    )

