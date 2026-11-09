

import json


class ChatError(Exception):
    """聊天业务错误只描述原因，由 API 层决定对应的 HTTP 状态。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def tool_error(code: str, message: str) -> str:
    return json.dumps(
        {
            "ok": False,
            "data": None,
            "error": {"code": code, "message": message},
        },
        ensure_ascii=False,
    )
