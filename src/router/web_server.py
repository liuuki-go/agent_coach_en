from fastapi import FastAPI, HTTPException
from uvicorn import run
from src.agents.english_teacher.model_main import invoke
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres import PostgresSaver

from src.common.dababase_pool import create_db_pool
from src.agents.english_teacher.agent_factory import build_agent
from src.common.session_store import SessionStore
from config.config_anasize import get_config_value
from uuid import UUID
from src.common.third_party_types import AgentGraph
from typing import Literal

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

from src.domains.session_domain import SessionMessageResponse
from src.agent_tools.common_tool import common_tools

@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = create_db_pool()

    try:
        pool.open(wait=True, timeout=5)

        checkpointer = PostgresSaver(pool)
        checkpointer.setup()

        session_store = SessionStore(pool)
        session_store.setup()
        #加载配置，以便加载默认模型
        model_config = get_config_value("MODEL_CONFIG", {})
        if (
            not isinstance(model_config, dict)
            or not model_config.get("model_name")
            or not model_config.get("base_url")
        ):
            raise ValueError(
                "MODEL_CONFIG 需要配置 model_name 和 base_url"
            )

        print("数据库连接池和 checkpointer 已就绪")
        # 创建默认的agent 实例 
        agent = build_agent(
            checkpointer=checkpointer,
            tools=common_tools, 
            model_name=model_config["model_name"],
            base_url=model_config["base_url"],
            temperature=model_config.get("temperature", 0),
        )
        print("agent 实例已创建")


        # 应用持有共享资源的
        app.state.db_pool = pool
        app.state.checkpointer = checkpointer
        app.state.agent = agent
        app.state.session_store = session_store
        yield

    finally:
        pool.close()
        print("数据库连接池已关闭")


app = FastAPI(
    title="langchain-ollama-agent",
    description="A simple agent using langchain-ollama",
    version="0.1.0",
    lifespan=lifespan,
)


from src.domains.chat_domain import UserMessage
# 心跳查询
@app.get("/health")
def health():
    return {"status": "ok"}

#执行聊天
@app.post("/api/chat")
def chat(request: UserMessage):
    session_store: SessionStore = app.state.session_store
    valid = valid_chat_request(request)
    if not valid:
        raise HTTPException(status_code=400, detail="请求参数无效")

    if session_store.get_session(request.session_id) is None:
        raise HTTPException(status_code=404, detail="会话不存在")

    agent: AgentGraph = app.state.agent
    user_message = {
        "role": "user",
        "content": request.content,
    }

    return invoke(
        user_message=user_message,
        agent=agent,
        session_id=request.session_id,
    )


from src.domains.session_domain import GetSessionByIdRequest
@app.get("/api/sessions/getAllSessions")
def get_all_sessions():
    "获取所有会话"
    session_store: SessionStore = app.state.session_store
    return session_store.list_sessions()


@app.post("/api/sessions/getSessionById")
def get_session_by_id(request: GetSessionByIdRequest):
    "根据ID获取会话"
    session_store: SessionStore = app.state.session_store

    session = session_store.get_session(request.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")

    return session

@app.post("/api/sessions/createSession")
def create_session(): 
    "创建新会话"
    session_store: SessionStore = app.state.session_store
    new_session_id = session_store.create_session()
    return {"session_id": new_session_id}

@app.post("/api/sessions/getSessionMessages")
def get_session_messages(
    request: GetSessionByIdRequest,
) -> list[SessionMessageResponse]:
    session_store: SessionStore = app.state.session_store

    if session_store.get_session(request.session_id) is None:
        raise HTTPException(status_code=404, detail="会话不存在")

    agent: AgentGraph = app.state.agent
    config: RunnableConfig = {
        "configurable": {
            "thread_id": str(request.session_id),
        }
    }

    snapshot = agent.get_state(config)
    saved_messages = snapshot.values.get("messages", [])

    result: list[SessionMessageResponse] = []

    for message in saved_messages:
        role: Literal["user", "assistant"]

        if isinstance(message, HumanMessage):
            role = "user"
        elif isinstance(message, AIMessage) and not message.tool_calls:
            role = "assistant"
        else:
            continue

        content = str(message.text)
        if not content.strip():
            continue

        result.append(
            SessionMessageResponse(
                id=message.id,
                role=role,
                content=content,
            )
        )

    return result

def valid_chat_request(request: UserMessage) -> bool:
    if not isinstance(request.session_id, UUID):
        return False
    if not isinstance(request.content, str) or not request.content.strip() or len(request.content) > 12000 :
        return False
    return True


