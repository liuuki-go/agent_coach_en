from getpass import getpass
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row

from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import (
    FakeMessagesListChatModel,
)
from langchain_core.messages import AIMessage
from langgraph.checkpoint.postgres import PostgresSaver


db_options = {
    "host": "127.0.0.1",
    "port": 5432,
    "dbname": "agent_test",
    "user": "agent_app",
    "password": getpass("请输入 agent_app 的数据库密码："),
    "connect_timeout": 5,
    "autocommit": True,
    "row_factory": dict_row,
}


def build_test_agent(checkpointer):
    model = FakeMessagesListChatModel(
        responses=[
            AIMessage(content="A的第一次回复"),
            AIMessage(content="B的第一次回复"),
            AIMessage(content="A的第二次回复"),
        ]
    )

    return create_agent(
        model=model,
        tools=[],
        system_prompt="这是数据库持久化验证。",
        checkpointer=checkpointer,
    )


def read_contents(agent, config):
    state = agent.get_state(config)
    return [message.content for message in state.values["messages"]]


test_id = str(uuid4())
config_a = {"configurable": {"thread_id": f"verify-a-{test_id}"}}
config_b = {"configurable": {"thread_id": f"verify-b-{test_id}"}}

expected_a = [
    "A的第一个问题",
    "A的第一次回复",
    "A的追问",
    "A的第二次回复",
]
expected_b = ["B的第一个问题", "B的第一次回复"]


with psycopg.connect(**db_options) as connection:
    identity = connection.execute(
        "SELECT current_user AS db_user, current_database() AS db_name"
    ).fetchone()
    print("数据库连接成功：", identity)

    checkpointer = PostgresSaver(connection)
    checkpointer.setup()
    print("checkpoint 表初始化完成")

    agent = build_test_agent(checkpointer)

    agent.invoke(
        {"messages": [{"role": "user", "content": "A的第一个问题"}]},
        config_a,
    )
    agent.invoke(
        {"messages": [{"role": "user", "content": "B的第一个问题"}]},
        config_b,
    )
    agent.invoke(
        {"messages": [{"role": "user", "content": "A的追问"}]},
        config_a,
    )

    assert read_contents(agent, config_a) == expected_a
    assert read_contents(agent, config_b) == expected_b
    print("会话隔离验证通过")


with psycopg.connect(**db_options) as connection:
    restored_agent = build_test_agent(PostgresSaver(connection))

    assert read_contents(restored_agent, config_a) == expected_a
    assert read_contents(restored_agent, config_b) == expected_b
    print("重新连接后，历史恢复验证通过")