import sys
from pathlib import Path

# 直接运行此文件时，将包含 src 的项目根目录加入模块搜索路径。
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn
from fastapi.staticfiles import StaticFiles

from src.router.web_server import app


# 复用现有聊天路由，最后挂载静态页面，让网页与 API 使用同一个地址。
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent, html=True), name="web_ui")


if __name__ == "__main__":
    print("Teresa Web UI: http://127.0.0.1:6576")
    uvicorn.run(app, host="127.0.0.1", port=6576)
