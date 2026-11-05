# Teresa 英语老师 Web UI

界面使用原生 HTML、CSS、JavaScript，无前端依赖。启动后直接连接现有后端，回复来自模型。头像与欢迎页使用 `assets/teresa.png`，空对话显示照片和欢迎语。

## 启动页面与现有后端

在 PowerShell 中从项目根目录运行：

```powershell
conda activate langchain
cd D:\codes_test\agent_test
python -m web_ui.main
```

也支持直接运行入口文件，包括编辑器的“运行 Python 文件”：

```powershell
& D:\conda_env\langchain\python.exe D:\codes_test\agent_test\web_ui\main.py
```

直接运行文件时，Python 的模块搜索起点是 `web_ui`。入口会根据自身位置补入项目根目录，以便找到同级的 `src`；不需要手动设置 `PYTHONPATH`。

打开 [http://127.0.0.1:6576](http://127.0.0.1:6576) 即可聊天。终端按 `Ctrl+C` 停止服务。

`web_ui/main.py` 复用 `src/service/web_server.py` 的 FastAPI `app`，在现有 API 后挂载静态页面，用一个进程同时提供界面和后端。**不要再同时启动一份旧的 `src.service.web_server` 服务**，它也使用 6576 端口；若旧服务正在运行，先停止它再运行上述命令。

Ollama 仍需独立运行。整个调用链是：浏览器 → 6576 上的 Python 后端 → Ollama。启动 Web UI 不会代替 Ollama 服务。

## 当前接口契约

前端向同源 `POST /api/chat` 发送 JSON，只包含当前最新一条用户消息：

```json
{"content": "I今天有点累。"}
```

`role` 由后端固定为 `user`。前端不发送 system 提示词、工具消息或整段聊天历史。

现有后端成功时直接返回一个 JSON 字符串，示例原始响应如下：

```json
"可以说：I'm a bit tired today."
```

前端也兼容先前的对象格式：

```json
{"reply": "可以说：I'm a bit tired today."}
```

当前为非流式响应，等待完整结果后显示。`GET /health` 返回 `{"status":"ok"}`，只能说明 Web 服务响应正常，不能证明模型已成功生成回复。

## 聊天保存在哪里

目前没有数据库持久化，也没有 `session_id`。历史分为两份：页面中的 `threads` 数组用于显示聊天；`src/agents/english_teacher/model_main.py` 中的全局 `history_messages` 列表已用于模型调用。这两份数据都只存在各自进程的内存中。

| 操作 | 网页上的聊天记录 | 后端的模型历史 |
| --- | --- | --- |
| 刷新或关闭网页 | 清空；重新打开从空界面开始 | 后端仍运行时保留 |
| 单独重启后端 | 已打开网页上的文字仍在 | 清空，重新建立列表 |
| 点击“开始新的对话” | 新建一个空的 UI 线程，旧线程仍可查看 | 不清空、不隔离全局历史 |
| 关闭网页并重启后端 | 清空 | 清空 |

因此，新对话或不同浏览器目前仍会共用同一份后端历史。页面展示的新线程，不代表模型获得了一段独立会话；刷新网页也不会要求后端忘记之前的内容。

页面文件和 `assets/teresa.png` 照片是磁盘上的文件，普通刷新或重启服务不会删除它们。它们的保留与聊天记录是否保存是两回事。

失败或停止等待后，未成功的消息会放回输入框，重试不会在 **UI 历史**中重复追加；停止等待不保证后端推理已停止。后端可能已经追加本次输入，失败后的历史回滚仍需在模型代码中练习处理。

后续可以用 SQLite 练习真正的会话保存：为每段对话创建 `session_id`，按会话保存消息的角色、内容和顺序；请求时只加载对应会话，新对话创建新 ID，重新打开时再读取已保存记录。这需要一起设计请求协议、后端和前端恢复流程，当前尚未实现。

## 验证与接入位置

从项目根目录运行：

```powershell
python -B -m unittest discover -s web_ui/tests -p 'test_*.py' -v
node --test web_ui/tests/api.test.js
```

Node.js 只用于前端协议测试，不是运行界面的必需依赖。测试通过不代表真实模型已验证，仍需从页面做一次真实问答。

- `web_ui/main.py`：复用后端并挂载界面的启动入口。
- `web_ui/api.js`：请求体和响应格式适配。
- `web_ui/assets/teresa.png`：照片头像。
- `src/service/web_server.py`：你编写的 HTTP 接口。
- `src/agents/english_teacher/model_main.py`：你练习模型、历史和工具循环的位置。

回复支持基础加粗、行内代码和代码块，其他 Markdown 按普通文字显示。
