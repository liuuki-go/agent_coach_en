

from uuid import UUID
from typing import Literal
from pydantic import BaseModel


class UserMessage(BaseModel):
    content: str
    session_id: UUID
    # 同一次逻辑发送重试时复用；迁移期间允许旧前端暂不提供。
    request_id: UUID | None = None


class ChatRequestErrorResponse(BaseModel):
    code: str
    message: str


class ChatRequestStatusResponse(BaseModel):
    request_id: UUID
    session_id: UUID
    status: Literal["processing", "succeeded", "failed"]
    reply: str | None = None
    error: ChatRequestErrorResponse | None = None
