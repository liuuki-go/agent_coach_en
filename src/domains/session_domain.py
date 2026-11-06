
from pydantic import BaseModel, ConfigDict
from uuid import UUID
from typing import Literal

class GetSessionByIdRequest(BaseModel):
    session_id: UUID




class SessionMessageResponse(BaseModel):
    id: str | None = None
    role: Literal["user", "assistant"]
    content: str