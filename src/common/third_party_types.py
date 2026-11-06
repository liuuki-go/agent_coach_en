"""项目使用的第三方类型入口，别名保留 SDK 的真实定义和方法跳转。"""

from collections.abc import Callable
from typing import Any, TypeAlias

from langchain.agents import AgentState
from langchain.agents.middleware.types import InputAgentState, OutputAgentState
from langchain_core.tools import BaseTool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph.state import CompiledStateGraph
from psycopg import Connection
from psycopg.rows import DictRow
from psycopg_pool import ConnectionPool


AgentGraph: TypeAlias = CompiledStateGraph[
    AgentState[Any], Any, InputAgentState, OutputAgentState[Any]
]
CheckpointSaver: TypeAlias = BaseCheckpointSaver[Any]
DatabasePool: TypeAlias = ConnectionPool[Connection[DictRow]]
ToolDefinition: TypeAlias = BaseTool | Callable[..., Any] | dict[str, Any]
