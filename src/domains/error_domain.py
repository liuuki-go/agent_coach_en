

import json


def tool_error(code: str, message: str) -> str:
    return json.dumps(
        {
            "ok": False,
            "data": None,
            "error": {"code": code, "message": message},
        },
        ensure_ascii=False,
    )