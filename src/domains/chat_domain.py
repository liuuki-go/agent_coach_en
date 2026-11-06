

from uuid import UUID
from pydantic import BaseModel


class UserMessage(BaseModel):
    content: str
    session_id: UUID
