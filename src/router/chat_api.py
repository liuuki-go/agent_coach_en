from fastapi import FastAPI, HTTPException
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres import PostgresSaver

from src.common.dababase_pool import create_db_pool
from src.agents.english_teacher.agent_factory import build_agent
from src.agents.english_teacher.model_factory import get_model_list
from src.agents.english_teacher.context_policy import get_context_budget
from src.common.db.session_store import SessionStore
from src.common.db.request_store import RequestStore
from src.common.db.message_store import MessageStore
from uuid import UUID
from src.domains.session_domain import SessionMessageResponse
from src.agent_tools.common_tool import common_tools
from src.common.agent_lock import SessionLocks
import logging
from src.service.chat_service import get_request_status, send_message
from src.domains.error_domain import ChatError
from src.domains.session_domain import GetSessionByIdRequest


logger = logging.getLogger(__name__)

# HTTP 状态属于接口协议，服务层只返回业务错误码。
_CHAT_ERROR_STATUS = {
    "SESSION_NOT_FOUND": 404,
    "SESSION_BUSY": 409,
    "MODEL_TIMEOUT": 504,
    "MODEL_UNAVAILABLE": 503,
    "MODEL_RESPONSE_ERROR": 502,
    "CHAT_FAILED": 500,
    "REQUEST_ID_CONFLICT": 409,
    "REQUEST_PROCESSING": 409,
    "REQUEST_STATE_UNKNOWN": 503,
    "REQUEST_NOT_FOUND": 404,
    "CHAT_HISTORY_SAVE_FAILED": 503,
    "CONTEXT_LIMIT_EXCEEDED": 413,
    "CONTEXT_STATE_INVALID": 409,
}

@asynccontextmanager
async def lifespan(app: FastAPI):
    model_list = get_model_list()
    get_context_budget()
    pool = create_db_pool()

    try:
        pool.open(wait=True, timeout=5)

        checkpointer = PostgresSaver(pool)
        checkpointer.setup()

        session_store = SessionStore(pool)
        session_store.setup()
        request_store = RequestStore(pool)
        request_store.setup()
        message_store = MessageStore(pool)
        message_store.setup()


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
        app.state.request_store = request_store
        app.state.message_store = message_store
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


from src.domains.chat_domain import (
    ChatRequestErrorResponse,
    ChatRequestStatusResponse,
    UserMessage,
)
# 心跳查询
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/models/getModelList")
def get_models():
    return app.state.model_list

#执行聊天
@app.post("/api/chat")
def chat(request: UserMessage) -> str:
    if not valid_chat_request(request):
        raise HTTPException(status_code=400, detail="请求参数无效")
    try:
        # 在接口边界取出共享资源，服务函数无需了解 app.state。
        return send_message(
            session_id=request.session_id,
            content=request.content,
            agent=app.state.agent,
            session_store=app.state.session_store,
            session_locks=app.state.session_locks,
            request_id=request.request_id,
            request_store=app.state.request_store,
            message_store=app.state.message_store,
        )
    except ChatError as exc:
        raise HTTPException(
            status_code=_CHAT_ERROR_STATUS.get(exc.code, 500),
            detail=exc.message,
        ) from None


@app.get("/api/chat/requests/{request_id}")
def get_chat_request(request_id: UUID, session_id: UUID) -> ChatRequestStatusResponse:
    try:
        record = get_request_status(
            session_id=session_id,
            request_id=request_id,
            session_store=app.state.session_store,
            request_store=app.state.request_store,
        )
    except ChatError as exc:
        raise HTTPException(
            status_code=_CHAT_ERROR_STATUS.get(exc.code, 500),
            detail=exc.message,
        ) from None

    # 数据库内部记录不直接作为公共响应，按状态只公开结果或安全错误。
    return ChatRequestStatusResponse(
        request_id=record["request_id"],
        session_id=record["session_id"],
        status=record["status"],
        reply=record["reply"] if record["status"] == "succeeded" else None,
        error=ChatRequestErrorResponse(
            code=record["error_code"], message=record["error_message"],
        ) if record["status"] == "failed" else None,
    )

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
    message_store: MessageStore = app.state.message_store
    try:
        session = session_store.get_session(request.session_id)
        # 历史只读业务档案；Checkpoint 中的消息裁剪不会影响网页记录。
        messages = [] if session is None else message_store.list_messages(request.session_id)
    except Exception as exc:
        logger.error(
            "chat_history_read_failed session_id=%s error_type=%s",
            request.session_id, type(exc).__name__,
        )
        raise HTTPException(
            status_code=503, detail="聊天档案暂时无法读取，请稍后重试",
        ) from None

    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")

    return [
        SessionMessageResponse(id=str(message["id"]), role=message["role"], content=message["content"])
        for message in messages
    ]

def valid_chat_request(request: UserMessage) -> bool:
    if not isinstance(request.session_id, UUID):
        return False
    if not isinstance(request.content, str) or not request.content.strip() or len(request.content) > 12000 :
        return False
    return True


