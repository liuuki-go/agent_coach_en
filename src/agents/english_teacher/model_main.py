

from src.common.third_party_types import AgentGraph
from langchain_core.runnables import RunnableConfig
from langchain_core.messages import AIMessage

def invoke(user_message: dict[str, str], agent: AgentGraph,session_id) -> str:

    #1.进行会话id绑定checkpointer的thread_id
    config = RunnableConfig({ "configurable": { "thread_id": str(session_id) } })


    result = agent.invoke(
        {"messages": [user_message]},
        config=config,
    )
    from langchain_core.messages import ToolMessage

    for message in result.get("messages", []):
        if isinstance(message, AIMessage) and message.tool_calls:
            print("工具请求：", message.tool_calls)
        elif isinstance(message, ToolMessage):
            print("工具结果：", message.name, message.tool_call_id)

    messages = result.get("messages", [])
    if not messages:
        raise RuntimeError("Agent 没有返回消息")

    last_message = messages[-1]
    if not isinstance(last_message, AIMessage) or last_message.tool_calls:
        raise RuntimeError("Agent 没有返回最终回复")

    reply = last_message.content
    if not isinstance(reply, str) or not reply.strip():
        raise RuntimeError("Agent 没有返回有效的文字回复")



    return reply


   








