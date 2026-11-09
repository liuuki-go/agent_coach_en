
from uuid import UUID

from src.agents.english_teacher.agent_runner import invoke
from src.common.agent_lock import SessionLocks
from src.common.db.session_store import SessionStore
from src.common.db.request_store import RequestStore
from src.common.db.message_store import MessageStore
from psycopg.rows import DictRow
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
    request_store: RequestStore,
    message_store: MessageStore,
    request_id: UUID | None = None,
) -> str:
    """组织一轮聊天；共享资源由调用方传入，服务不依赖 FastAPI 应用。"""
    # 检查会话存在，不存在则报错结束本次业务
    if session_store.get_session(session_id) is None:
        raise ChatError("SESSION_NOT_FOUND", "会话不存在")

    # 回放发生在加锁前，已完成的旧请求不必等待同会话的新一轮聊天。
    if request_id is not None:
        record = _get_saved_request(request_store, request_id)
        if record is not None:
            return _reply_from_saved_request(record, session_id, content)

    # 加锁，用于防止资源竞争
    lock = session_locks.get(session_id)
    if not lock.acquire(blocking=False):
        raise ChatError(
            "SESSION_BUSY", "当前会话正在处理消息，请等待完成",
        )

    # 1.执行模型调用流程
    try:
        if request_id is not None:
            try:
                created = request_store.try_start(
                    request_id=request_id,
                    session_id=session_id,
                    content=content,
                )
            except Exception as exc:
                logger.error(
                    "request_registration_failed request_id=%s error_type=%s",
                    request_id,
                    type(exc).__name__,
                )
                # 登记可能已经提交；无法确认时不能继续调用模型。
                raise ChatError(
                    "REQUEST_STATE_UNKNOWN",
                    "请求登记结果暂时无法确认，请保留原请求 ID。",
                ) from None

            if created is None:
                # 预查询之后，另一个执行者可能已经登记了同一个 ID。
                record = _get_saved_request(request_store, request_id)

                if record is None:
                    raise ChatError(
                        "REQUEST_STATE_UNKNOWN",
                        "请求登记结果暂时无法确认，请保留原请求 ID。",
                    )

                return _reply_from_saved_request(record, session_id, content)


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
            error = ChatError(
                "MODEL_TIMEOUT", "模型响应超时，请稍后查询历史确认结果",
            )
            _save_request_failure(request_store, request_id, error)
            raise error from None
        except (httpx.RequestError, ConnectionError):
            error = ChatError(
                "MODEL_UNAVAILABLE", "暂时无法连接模型服务",
            )
            _save_request_failure(request_store, request_id, error)
            raise error from None
        except ResponseError:
            error = ChatError(
                "MODEL_RESPONSE_ERROR", "模型服务返回异常",
            )
            _save_request_failure(request_store, request_id, error)
            raise error from None
        except ChatError as error:
            # 上下文超限等业务拒绝保留具体原因，失败回放也不重新调用模型。
            _save_request_failure(request_store, request_id, error)
            raise
        except Exception as exc:
            logger.error(
                "chat_failed session_id=%s error_type=%s",
                session_id,
                type(exc).__name__,
            )
            error = ChatError(
                "CHAT_FAILED", "聊天处理失败，请稍后查询历史确认结果",
            )
            _save_request_failure(request_store, request_id, error)
            raise error from None

        # 模型在事务外执行；仅把消息归档和请求成功状态放入同一个短事务。
        _save_chat_success(
            message_store, request_store, session_id, request_id, content, reply,
        )

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


def get_request_status(
    session_id: UUID,
    request_id: UUID,
    *,
    session_store: SessionStore,
    request_store: RequestStore,
) -> DictRow:
    try:
        session = session_store.get_session(session_id)
    except Exception as exc:
        logger.error(
            "request_session_lookup_failed request_id=%s error_type=%s",
            request_id,
            type(exc).__name__,
        )
        raise ChatError(
            "REQUEST_STATE_UNKNOWN",
            "请求状态暂时无法确认，请保留原请求 ID。",
        ) from None
    if session is None:
        raise ChatError("SESSION_NOT_FOUND", "会话不存在")

    record = _get_saved_request(request_store, request_id)
    # 查询接口不暴露其他会话的请求及回复。
    if record is None or record["session_id"] != session_id:
        raise ChatError("REQUEST_NOT_FOUND", "请求不存在")
    if record["status"] not in {"processing", "succeeded", "failed"}:
        raise ChatError("REQUEST_STATE_UNKNOWN", "请求状态暂时无法确认。")
    return record


def _get_saved_request(request_store: RequestStore, request_id: UUID) -> DictRow | None:
    try:
        return request_store.get_request(request_id)
    except Exception as exc:
        logger.error(
            "request_lookup_failed request_id=%s error_type=%s",
            request_id,
            type(exc).__name__,
        )
        raise ChatError(
            "REQUEST_STATE_UNKNOWN",
            "请求状态暂时无法确认，请保留原请求 ID。",
        ) from None


def _reply_from_saved_request(
    record: DictRow,
    session_id: UUID,
    content: str,
) -> str:
    # 先核对请求身份，不能把另一个输入的结果当成当前回复。
    if record["session_id"] != session_id or record["content"] != content:
        raise ChatError(
            "REQUEST_ID_CONFLICT",
            "该请求 ID 已用于其他会话或内容，请勿复用。",
        )

    status = record["status"]

    if status == "succeeded":
        return record["reply"]

    if status == "processing":
        raise ChatError(
            "REQUEST_PROCESSING",
            "该请求尚未完成，请稍后查询请求状态。",
        )

    if status == "failed":
        raise ChatError(record["error_code"], record["error_message"])

    raise ChatError(
        "REQUEST_STATE_UNKNOWN",
        "请求状态暂时无法确认，请保留原请求 ID。",
    )


def _save_chat_success(
    message_store: MessageStore,
    request_store: RequestStore,
    session_id: UUID,
    request_id: UUID | None,
    content: str,
    reply: str,
) -> None:
    try:
        with message_store.pool.connection() as connection:
            with connection.transaction():
                message_store.add_exchange(
                    connection, session_id, request_id, content, reply,
                )
                if request_id is not None:
                    saved = request_store.mark_succeeded(
                        request_id, reply, connection=connection,
                    )
                    if not saved:
                        # 必须在事务块内抛出，连同刚插入的消息一起回滚。
                        raise ChatError("REQUEST_STATE_UNKNOWN", "请求状态未能确认")
    except Exception as exc:
        logger.error(
            "request_success_save_failed request_id=%s error_type=%s",
            request_id,
            type(exc).__name__,
        )
        if request_id is None:
            raise ChatError(
                "CHAT_HISTORY_SAVE_FAILED",
                "回复已生成，但聊天档案保存结果尚未确认，请勿直接重复发送。",
            ) from None
        raise ChatError(
            "REQUEST_STATE_UNKNOWN",
            "回复已生成，但聊天档案与请求结果保存尚未确认，请保留原请求 ID。",
        ) from None


def _save_request_failure(
    request_store: RequestStore,
    request_id: UUID | None,
    error: ChatError,
) -> None:
    if request_id is None:
        return

    try:
        saved = request_store.mark_failed(
            request_id,
            error.code,
            error.message,
        )
    except Exception as exc:
        logger.error(
            "request_failure_save_failed request_id=%s error_type=%s",
            request_id,
            type(exc).__name__,
        )
        raise ChatError(
            "REQUEST_STATE_UNKNOWN",
            "请求失败，但状态保存结果尚未确认，请保留原请求 ID。",
        ) from None

    if not saved:
        raise ChatError(
            "REQUEST_STATE_UNKNOWN",
            "请求状态未能确认，请保留原请求 ID 并查询。",
        )
