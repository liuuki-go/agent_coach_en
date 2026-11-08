from fastapi import FastAPI, HTTPException
from src.agents.english_teacher.model_main import invoke
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres import PostgresSaver

from src.common.dababase_pool import create_db_pool
from src.agents.english_teacher.agent_factory import build_agent
from src.agents.english_teacher.model_factory import get_model_list
from src.common.session_store import SessionStore
from uuid import UUID
from src.common.third_party_types import AgentGraph
from typing import Literal

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

from src.domains.session_domain import SessionMessageResponse
from src.agent_tools.common_tool import common_tools
from src.common.agent_lock import SessionLocks
import logging

import httpx
from ollama import ResponseError

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    model_list = get_model_list()
    pool = create_db_pool()

    try:
        pool.open(wait=True, timeout=5)

        checkpointer = PostgresSaver(pool)
        checkpointer.setup()

        session_store = SessionStore(pool)
        session_store.setup()
        print("数据库连接池和 checkpointer 已就绪")
        # 创建默认的agent 实例 
        agent = build_agent(
            checkpointer=checkpointer,
            tools=common_tools, 
        )
        print("agent 实例已创建")


        # 应用持有共享资源的
        app.state.db_pool = pool
        app.state.checkpointer = checkpointer
        app.state.agent = agent
        app.state.model_list = model_list
        app.state.session_store = session_store
        app.state.session_locks = SessionLocks()
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


@app.get("/api/models/getModelList")
def get_models():
    return app.state.model_list

#执行聊天
@app.post("/api/chat")
def chat(request: UserMessage):
    if not valid_chat_request(request):
        raise HTTPException(status_code=400, detail="请求参数无效")

    # 检查会话存在，不存在则报错结束本次业务
    session_store: SessionStore = app.state.session_store
    if session_store.get_session(request.session_id) is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    
    lock = app.state.session_locks.get(request.session_id)

    if not lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="当前会话正在处理消息，请等待完成",
        )

    try:
        agent: AgentGraph = app.state.agent
        user_message = {
            "role": "user",
            "content": request.content,
        }
    
        try:
            reply = invoke(
                user_message=user_message,
                agent=agent,
                session_id=request.session_id,
            )
        except httpx.TimeoutException:
            raise HTTPException(
                status_code=504,
                detail="模型响应超时，请稍后查询历史确认结果",
            ) from None
        except (httpx.RequestError, ConnectionError):
            raise HTTPException(
                status_code=503,
                detail="暂时无法连接模型服务",
            ) from None
        except ResponseError:
            raise HTTPException(
                status_code=502,
                detail="模型服务返回异常",
            ) from None
        except Exception as exc:
            logger.error(
                "chat_failed session_id=%s error_type=%s",
                request.session_id,
                type(exc).__name__,
            )
            raise HTTPException(
                status_code=500,
                detail="聊天处理失败，请稍后查询历史确认结果",
            ) from None

        # 回复已成功生成，更新时间失败不改变本轮聊天结果。
        try:
            updated = session_store.touch_session(request.session_id)
            if not updated:
                logger.warning(
                    "session_touch_missing session_id=%s",
                    request.session_id,
                )
        except Exception as exc:
            logger.error(
                "session_touch_failed session_id=%s error_type=%s",
                request.session_id,
                type(exc).__name__,
            )

        return reply

    finally:
        lock.release()



 


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


