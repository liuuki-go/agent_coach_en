# Teresa 英语老师 Web UI

界面使用原生 HTML、CSS、JavaScript，无前端运行依赖。前端按当前已有的后端接口接入会话列表、新建、历史查询和聊天响应，不要求修改后端接口风格，也不提供模拟会话或假回复。

## 启动

在 PowerShell 中从项目根目录运行：

```powershell
Set-Location -LiteralPath 'D:\codes_test\agent_test'
& 'D:\conda_env\langchain\python.exe' -B -m web_ui.main
```

也支持直接运行入口文件：

```powershell
& 'D:\conda_env\langchain\python.exe' -B 'D:\codes_test\agent_test\web_ui\main.py'
```

打开 [http://127.0.0.1:6576](http://127.0.0.1:6576)，终端按 `Ctrl+C` 停止服务。`web_ui/main.py` 复用 `src/service/web_server.py` 的 FastAPI `app`，同一个进程提供页面和 API。PostgreSQL 与 Ollama 仍需独立运行，配置读取自现有 `src/config/sys_config.yaml`。

更新前端后，如果页面仍显示旧提示，先按 `Ctrl+F5` 强制刷新。入口脚本及其 API 模块使用相同的版本参数以区分旧缓存；后续更新脚本时应同步更新两处版本。服务重启不会清除浏览器保存的会话 ID；切换域名或端口会改变浏览器存储范围，但页面仍会从服务端已有会话列表恢复。

## 当前前端行为与能力边界

- 打开页面读取服务端会话列表；列表为空时创建一段会话；否则选择上次选中的会话或列表第一项。
- “开始新的对话”使用后端生成的会话 ID。打开页面、切换会话和点击刷新按钮时，分别读取会话元数据与历史消息。
- 历史查询成功后，用服务端返回的消息替换该会话的显示内容，不拼接重复历史；空数组表示当前没有可展示消息。查询失败会明确报错，并保留原会话及其已显示消息，不把失败当成空历史。
- 成功收到聊天回复后立即显示本轮输入和真实回复，再查询历史同步服务端保存的内容。如果同步失败或返回历史尚未包含本轮回复，保留已经收到的内容并提示稍后刷新确认，不重新发送聊天。
- 浏览器 `localStorage` 只保存选中的会话 ID，不保存消息或草稿。刷新整个页面、关闭再打开后，用这个 ID 重新读取服务端历史。未发送的草稿只在当前页面内按会话保留。
- 历史消息当前没有创建时间，页面不显示历史消息时间，也不伪造消息 ID、时间、会话标题或更新时间。本次发送和收到回复的本地时间仅用于同步前的即时显示。

当前历史接口读取的是 Agent 最新保存状态中的可展示消息，页面显示范围取决于后端保留的状态。后续如果后端裁剪或摘要旧消息，最新状态可能不再包含全部原始聊天记录；完整档案、分页和搜索需按后续业务需求另行实现。本轮只适配前端，没有改动 checkpoint 的后端实现。

## 当前实际 API

| 方法与路径 | 请求 | 当前响应 |
| --- | --- | --- |
| `GET /api/sessions/getAllSessions` | 无 body | 会话对象的裸数组 |
| `POST /api/sessions/createSession` | JSON `{}` | `{ "session_id": 会话对象 }`，状态码 200 |
| `POST /api/sessions/getSessionById` | `{ "session_id": "UUID" }` | 单个会话对象，不存在时 404 |
| `POST /api/sessions/getSessionMessages` | `{ "session_id": "UUID" }` | 消息对象的裸数组；空会话为 `[]`，不存在时 404 |
| `POST /api/chat` | `{ "session_id": "UUID", "content": "本次输入" }` | JSON 字符串形式的回复 |

会话对象包含 `id`、`title`、`created_at`、`updated_at`。时间为 ISO 字符串，前端转换为 `Date`。`createSession` 当前字段名虽为 `session_id`，其值实际是完整会话对象；前端已按这个现状解包。

历史消息对象包含 `id`（字符串或 `null`）、`role`（`user` 或 `assistant`）与 `content`（文字）。接口不返回逐条消息时间，前端不要求该字段；消息顺序沿用后端数组顺序。系统消息、工具结果和工具调用中间消息由后端过滤，前端也校验可展示角色。

聊天只发送当前会话 ID 和本次用户输入：

```json
{
  "session_id": "11111111-1111-4111-8111-111111111111",
  "content": "I'm a bit tired today."
}
```

成功响应例如：

```json
"可以说：I'm a bit tired today."
```

前端同时兼容 `{ "reply": "文字回复" }`。请求不发送整段消息历史、system 提示词或 `request_id`，响应也不要求返回请求 ID。

## 失败与停止等待

点击“停止等待”或等待超过两分钟，只会中止浏览器等待；后端可能已经执行或仍在处理。页面保留输入草稿并说明重新发送可能重复执行，由用户决定是否再次发送，不自动重发。

网络失败或响应丢失时，后端可能已经保存部分或全部消息。可以点击刷新按钮查询目前已保存的消息，但历史读取不能证明请求一定完成或一定取消。页面不会自动重发；当前后端没有请求幂等协议，重新发送仍可能重复执行。

## Python 第三方类型声明

`src/common/third_party_types.py` 集中声明真实 SDK 的类型别名，Agent 工厂返回值、相关形参及从 `app.state` 取出的局部变量已接入类型提示。它只帮助静态分析和代码导航，不替换模型，也不改变第三方运行时实现。

在 VS Code 中选择解释器 `D:\conda_env\langchain\python.exe`，输入 `agent.` 后可用 `Ctrl+Space` 查看补全，用 `F12` 跳转。Agent 的 `invoke` 实现继承自 `Pregel`，跳转到父类是正常行为。

当前聊天调用已经通过状态输入与 `thread_id` 接入 Agent；历史查询使用相同的会话 ID 读取状态。类型提示仍只帮助编辑器，真实数据库、模型和工具执行能力需要独立联调。

## 验证

从项目根目录执行：

```powershell
node --test web_ui/tests/api.test.js web_ui/tests/ui.test.js
node --check web_ui/app.js
node --check web_ui/api.js
& 'D:\conda_env\langchain\python.exe' -B -m unittest discover -s web_ui/tests -p 'test_*.py' -v
```

Node.js 只用于测试。测试夹具验证当前真实 API 的路径、方法与数据结构，并用轻量 DOM 驱动实际 `app.js`，覆盖首次历史加载、会话切换、页面重新打开、无时间消息、重复刷新、空历史、草稿、历史读取失败、回复同步失败、停止等待和文本安全渲染。测试不调用真实数据库或模型，生产页面也不使用测试夹具；测试通过不等于真实持久化和模型联调已经完成。

服务启动后打开 [消息布局回归测试](http://127.0.0.1:6576/tests/layout.test.html)，页面会在 320、390、1280、1920px 四种视口中加载实际前端，检查用户消息靠右且为绿色、AI 消息靠左且为白色，以及长文本、代码块和等待回复时的布局。测试 iframe 隔离 API 和浏览器存储，不读写真实聊天记录或已选会话。

Python 测试覆盖页面入口和实际 FastAPI 的请求、响应协议，包括历史消息过滤、空会话、不存在会话与会话 ID 传递。它同样隔离真实数据库和模型调用。

真实联调可在 A 会话发送一段内容，切到 B 确认互不混入，再切回 A、刷新整个页面，确认服务端历史可恢复。随后重启后端再次读取 A；还应验证空会话和查询失败时的提示。当前历史未提供消息时间，页面不应出现虚构的历史时间。

头像与欢迎页使用 `assets/teresa.png`。回复支持基础加粗、行内代码和代码块，其余 Markdown 按普通文字显示；模型内容只创建文本节点，不执行返回的 HTML。
