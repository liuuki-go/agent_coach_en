
from uuid import UUID

from src.agents.english_teacher.agent_runner import invoke
from src.common.agent_lock import SessionLocks
from src.common.session_store import SessionStore
from src.common.third_party_types import AgentGraph
from src.domains.error_domain import ChatError
import httpx
from ollama import ResponseError
import logging

logger = logging.getLogger(__name__)

def send_message(
    session_id: UUID,
    content: str,
    *,
    agent: AgentGraph,
    session_store: SessionStore,
    session_locks: SessionLocks,
) -> str:
    """组织一轮聊天；共享资源由调用方传入，服务不依赖 FastAPI 应用。"""
    # 检查会话存在，不存在则报错结束本次业务
    if session_store.get_session(session_id) is None:
        raise ChatError("SESSION_NOT_FOUND", "会话不存在")
    
    lock = session_locks.get(session_id)

    if not lock.acquire(blocking=False):
        raise ChatError(
            "SESSION_BUSY", "当前会话正在处理消息，请等待完成",
        )

    try:
        user_message = {
            "role": "user",
            "content": content,
        }
    
        try:
            reply = invoke(
                user_message=user_message,
                agent=agent,
                session_id=session_id,
            )
        except httpx.TimeoutException:
            raise ChatError(
                "MODEL_TIMEOUT", "模型响应超时，请稍后查询历史确认结果",
            ) from None
        except (httpx.RequestError, ConnectionError):
            raise ChatError(
                "MODEL_UNAVAILABLE", "暂时无法连接模型服务",
            ) from None
        except ResponseError:
            raise ChatError(
                "MODEL_RESPONSE_ERROR", "模型服务返回异常",
            ) from None
        except Exception as exc:
            logger.error(
                "chat_failed session_id=%s error_type=%s",
                session_id,
                type(exc).__name__,
            )
            raise ChatError(
                "CHAT_FAILED", "聊天处理失败，请稍后查询历史确认结果",
            ) from None

        # 回复已成功生成，更新时间失败不改变本轮聊天结果。
        try:
            updated = session_store.touch_session(session_id)
            if not updated:
                logger.warning(
                    "session_touch_missing session_id=%s",
                    session_id,
                )
        except Exception as exc:
            logger.error(
                "session_touch_failed session_id=%s error_type=%s",
                session_id,
                type(exc).__name__,
            )

        return reply

    finally:
        lock.release()

