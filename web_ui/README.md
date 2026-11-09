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

打开 [http://127.0.0.1:6576](http://127.0.0.1:6576)，终端按 `Ctrl+C` 停止服务。`web_ui/main.py` 复用 `src/router/chat_api.py` 的 FastAPI `app`，同一个进程提供页面和 API。PostgreSQL 与 Ollama 仍需独立运行，配置读取自 `config/sys_config.yaml`。

更新前端后，如果页面仍显示旧提示，先按 `Ctrl+F5` 强制刷新。入口脚本、样式、API 和请求记录模块使用相同的版本参数以区分旧缓存；后续更新时同步维护这些引用。服务重启不会清除浏览器保存的会话 ID 和未确认请求；切换域名或端口会改变浏览器存储范围，原请求记录不会自动迁移。

## 配置默认模型

模型统一由服务端配置决定，原 `MODEL_CONFIG` 已迁移为：

```yaml
model_list:
  default: qwen3.5:4b-q4_K_M
  models:
    - name: qwen3.5:4b-q4_K_M
      display_name: 本地 Qwen3.5 4B
      base_url: http://127.0.0.1:11434
      temperature: 0
```

示例中的 `name` 应替换为已部署在 Ollama 中的模型名称。可以配置多项，`default` 必须精确对应其中一项的 `name`，名称不能重复。`display_name` 可省略，默认显示 `name`；`temperature` 可省略，默认 0。`base_url` 由服务端配置，不返回给浏览器。原先未参与模型构造的 `max_tokens` 项已移除。

启动时会校验并保存配置快照，只创建 `default` 对应的模型。`get_model()` 不接收模型名、服务地址或切换参数；Agent 工厂只接收 checkpointer 和工具。修改列表或默认名称后，重启服务生效。

输入区的模型菜单从后端读取名称列表，标记当前默认项；其他项仅供查看，没有选择或切换操作。前端不保存模型偏好，聊天请求也不携带模型参数。模型列表读取失败会独立提示，不阻塞已有聊天和历史加载。

## 当前前端行为与能力边界

- 打开页面读取服务端会话列表；列表为空时创建一段会话；否则选择上次选中的会话或列表第一项。
- “开始新的对话”使用后端生成的会话 ID。打开页面、切换会话和点击刷新按钮时，分别读取会话元数据与历史消息。
- 历史查询成功后，用服务端返回的消息替换该会话的显示内容，不拼接重复历史；空数组表示当前没有可展示消息。查询失败会明确报错，并保留原会话及其已显示消息，不把失败当成空历史。
- 成功收到聊天回复后立即显示本轮输入和真实回复，再查询历史同步服务端保存的内容。如果同步失败或返回历史尚未包含本轮回复，保留已经收到的内容并提示稍后刷新确认，不重新发送聊天。
- 浏览器 `localStorage` 保存选中的会话 ID，以及尚需恢复的请求 ID、会话、原文、创建时间和已知结果。每个请求单独保存，不归档整段聊天；成功且历史已同步，或用户确认继续后，移除对应请求记录。未发送的草稿只在当前页面内按会话保留。
- 每次新发送通过 `crypto.randomUUID()` 生成 ID，先保存再 POST；存储失败时不发送。超时、停止等待或网络失败都保留原 ID 和原文，查询与重试不会生成另一个 ID。
- 刷新、切换或重开页面时，读取当前会话未确认的请求并查询状态，不自动 POST。“查询结果”只读；“重试原消息”复用原 ID；确认失败后点击“开始新消息”，之后的发送才使用新 ID。未确认时编辑正文不能覆盖原请求。
- 历史消息当前没有创建时间，页面不显示历史消息时间，也不伪造消息 ID、时间、会话标题或更新时间。本次发送和收到回复的本地时间仅用于同步前的即时显示。

历史接口读取独立的 `chat_messages` 业务档案，保存成功轮次的用户原文与最终助手回复。Agent 的 Checkpoint 继续负责会话接续；模型调用前按预算临时选择近期输入，不删除网页档案或 Checkpoint 原消息。摘要、分页、搜索和失败消息展示仍可后续实现。

## 当前实际 API

| 方法与路径 | 请求 | 当前响应 |
| --- | --- | --- |
| `GET /api/models/getModelList` | 无 body | `{ "default": "名称", "models": [{ "name": "名称", "display_name": "显示名" }] }`，为服务启动时的只读模型列表 |
| `GET /api/sessions/getAllSessions` | 无 body | 会话对象的裸数组 |
| `POST /api/sessions/createSession` | JSON `{}` | `{ "session_id": 会话对象 }`，状态码 200 |
| `POST /api/sessions/getSessionById` | `{ "session_id": "UUID" }` | 单个会话对象，不存在时 404 |
| `POST /api/sessions/getSessionMessages` | `{ "session_id": "UUID" }` | 消息对象的裸数组；空会话为 `[]`，不存在时 404 |
| `POST /api/chat` | `{ "session_id": "UUID", "content": "本次输入", "request_id": "UUID（可选）" }` | JSON 字符串形式的回复 |
| `GET /api/chat/requests/{request_id}?session_id=UUID` | 路径中的请求 ID 和查询参数中的会话 ID | `{ "request_id", "session_id", "status", "reply", "error" }`；记录不存在或属于其他会话时 404 |

会话对象包含 `id`、`title`、`created_at`、`updated_at`。时间为 ISO 字符串，前端转换为 `Date`。`createSession` 当前字段名虽为 `session_id`，其值实际是完整会话对象；前端已按这个现状解包。

历史消息对象包含 `id`（业务消息 UUID 字符串）、`role`（`user` 或 `assistant`）与 `content`（文字）；前端继续兼容旧的空 ID。接口不公开逐条消息时间，顺序按业务档案的 `sequence` 升序。系统指令、工具结果和工具调用中间消息留在 Agent 状态中，不作为聊天档案写入。

网页聊天只发送当前会话 ID、本次用户输入和这次发送的请求 ID：

```json
{
  "session_id": "11111111-1111-4111-8111-111111111111",
  "content": "I'm a bit tired today.",
  "request_id": "33333333-3333-4333-8333-333333333333"
}
```

成功响应例如：

```json
"可以说：I'm a bit tired today."
```

前端同时兼容 `{ "reply": "文字回复" }`。请求不发送整段消息历史或 system 提示词，聊天响应也不要求返回请求 ID。底层 `sendChat` 保留无 ID 的旧调用兼容性，实际页面始终传入 ID。

## 后端请求状态与幂等

后端允许聊天请求携带可选 `request_id`。调用方为一次逻辑发送生成一个 UUID，并在该次发送的重试中复用原 ID、会话和内容。同 ID 不同会话或内容返回 409；相同请求已成功时回放保存的原回复，处理中返回 409，已失败时返回保存的公开错误，都不会再次调用模型。未提供 ID 的旧请求保留原行为，不读写请求记录。

状态查询返回 `processing`、`succeeded` 或 `failed`。成功时只有 `reply` 有值，失败时只有 `error` 包含公开的 `code/message`；查询不会执行模型。查询先核对会话，其他会话的记录按不存在处理。未来多人使用时仍需增加用户归属校验。

请求登记、查询或终态保存无法确认时返回 503。模型已经生成回复但结果保存失败，也不能视为已经登记成功；客户端应保留原 ID，之后查询或以同 ID 重提，后端不会自动重新执行未决请求。服务重启后遗留的 `processing` 也不会按时间自动重置。请求记录和 Checkpoint 分别保存，本阶段不保证中途崩溃时自动恢复执行。

当前网页已接入 ID 生成、持久化、同 ID 重试与状态查询。`pending` 是浏览器的“尚未确认”状态，不能直接等同后端 `processing`；只有成功 POST 或按 ID 查询返回终态才确认结果。已知回复与历史分开展示、同步时替换，避免回放时再次追加同一轮。聊天请求幂等不包含新建会话的去重，也不能跨域名、端口、浏览器或清除本地记录后自动找回原 ID。

`chat_requests` 由启动流程在会话表之后初始化；`CREATE TABLE IF NOT EXISTS` 不会升级已有旧表结构。本阶段沿用单进程会话锁，多个 worker 下不同请求 ID 修改同一会话还需要额外协调。

## 聊天档案与事务

`MessageStore` 位于 `src/common/db/message_store.py`。`chat_messages` 保存业务消息 ID、会话 ID、可空的请求 ID、角色、原文、归档时间 `created_at` 和稳定排序字段 `sequence`。`created_at` 表示归档写入时间，不代表浏览器发送或收到消息的精确时间；`sequence` 可以有空号，不用于计数。第一版每个成功请求仅有一条用户消息和一条最终助手回复，通过 `UNIQUE(request_id, role)` 防止同 ID 重复归档。失败原文与安全错误仍由 `chat_requests` 保存，不伪造成功回复。无 ID 的旧调用也保存消息对，但不增加请求记录或幂等保证。

事务边界放在服务层的 `_save_chat_success`，模型调用成功后才执行：

```python
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
                raise ChatError("REQUEST_STATE_UNKNOWN", "请求状态未能确认")
```

两个 Store 使用同一个 `connection`，不自行提交：正常退出事务块才提交；插入异常、终态更新异常或更新行数为零时，在块内抛错，使消息对和成功状态一起回滚。模型生成不在此事务中，避免长时间占用事务。连接池的 `autocommit=True` 不影响这里的显式事务，这是 [Psycopg 官方支持的事务用法](https://www.psycopg.org/psycopg3/docs/basic/transactions.html)。归档或提交结果不明时，带 ID 请求返回 503 并保留原 ID，不把它改写成模型失败；无 ID 的旧调用返回安全的 `CHAT_HISTORY_SAVE_FAILED`，需要人工确认，不能承诺去重。

本次复用现有 Psycopg、PostgreSQL 约束和事务，不增加依赖。已评估 LangChain 的 `PostgresChatMessageHistory`，其通用框架消息结构不直接包含业务请求约束，当前写入实现还会自行 `commit()`，不适合直接组合到这个业务提交边界；参考 [官方实现](https://github.com/langchain-ai/langchain-postgres/blob/main/langchain_postgres/chat_message_histories.py)。现有 LangGraph `PostgresSaver` 保持不变；它的执行快照与业务事务仍分别提交，进程崩溃协调和自动恢复未在本项实现。

重启后，启动流程按会话表、请求表、消息表的顺序初始化。消息表初始化会幂等回填已有 `succeeded` 请求中的原文和回复；首次回填按请求创建时间、请求 ID、用户/助手顺序写入，重复启动不覆盖已有消息。回填的 `created_at` 是本次归档时间，不猜测历史发送时间。缺项采用追加归档顺序，不支持混跑旧版本后重新整理历史顺序。只有 Checkpoint、没有成功请求记录的更早聊天仍留在框架中，需要单独导出迁移；历史接口不以 Checkpoint 作为空档案的隐式回退来源。

聊天档案与 Agent 状态使用独立数据源。调用 Agent 仍只传本轮新输入，既有上下文由 Checkpointer 接续；不把整份档案重复传入 Agent。每次模型调用的预算与临时选择见下节，摘要和跨会话偏好后续实现。

## 上下文预算与临时输入选择

`config/sys_config.yaml` 现在包含独立配置，修改后重启服务生效：

```yaml
context_budget:
  context_window_tokens: 8192
  max_output_tokens: 1024
  safety_margin_tokens: 512
  chars_per_token: 1.0
```

- `context_window_tokens`：项目设置的总窗口，同时传给 ChatOllama 的 `num_ctx`。初始值 8192 是本项目的运行设置，不是自动探测出的模型或硬件上限；需结合实际内存与模型能力调整。
- `max_output_tokens`：生成预留，同时传给 `num_predict`。达到生成上限可能使回复不完整，不应把它理解成模型一定生成这么多 token。
- `safety_margin_tokens`：为聊天模板和估算误差预留的空间。
- `chars_per_token`：内置近似计数的字符/token 参数。中英混合内容先用较保守的 1.0；越小估算 token 越多，需要用实际模型统计校准。

可用估算输入预算为 `8192 - 1024 - 512 = 6656`。四项均需显式配置，启动时使用现有 Pydantic 验证类型、范围、未知字段和预算关系；验证失败先于数据库资源初始化。模型和中间件共享缓存的冻结配置，避免两边使用不同预算。模型名称列表仍只公开名称与显示名，不向浏览器公开预算或连接配置。

`src/agents/english_teacher/context_policy.py` 复用 LangChain 的 `wrap_model_call`、`request.override()`、`trim_messages` 和 `count_tokens_approximately`，没有增加依赖。每次模型调用都执行以下步骤：

1. 找到最后一条 `HumanMessage`，保护从它开始到末尾的本轮全部消息，包含当前工具调用和匹配结果。
2. 将独立的 `system_message`、工具定义和本轮内容一起计数；这些必需内容本身超过预算时，直接拒绝调用模型，不静默截断当前问题或工具结果。
3. 使用内置 `trim_messages(strategy="last", start_on="human", allow_partial=False)` 在剩余空间选择最近历史，从用户消息边界开始，不切分消息原文。
4. 再次检查所选工具 ID 配对和总估算，只把新列表放入 `request.override(messages=...)`。原消息对象、`request.state`、Checkpoint 和 MessageStore 都不被删改。

一次 HTTP 请求可能执行多次模型调用，工具结果返回后会再次经过上述选择。临时选择减少的是每次发送给模型的内容，Checkpoint 仍会积累；本阶段不做持久摘要、长期记忆或旧状态清理。当前中间件适配项目的同步 `agent.invoke()`，将来切换 `ainvoke()` 需补充异步 hook。

超预算返回 `CONTEXT_LIMIT_EXCEEDED`（HTTP 413），缺失本轮用户消息或工具记录不完整返回 `CONTEXT_STATE_INVALID`（HTTP 409）。服务层保留具体错误并保存请求 `failed`，不写成功聊天档案；同 ID 重试回放原错误，不再次执行模型。前端可先“查询结果”确认失败，再“开始新消息”编辑发送；不完整的旧工具链按提示新建会话。错误发生前图可能已经保存本轮输入或工具结果，`failed` 不代表 Checkpoint 回滚。

### Token 估算与 UI 用量

本次估算用于后端预算控制，保持原有聊天字符串响应；UI 暂不显示 token 用量。每次模型调用产生安全的 INFO 日志事件，包含选择前后的 `estimated_input_tokens_before/after`、`input_budget_tokens` 和 `dropped_messages`；超限还记录必需输入的估算数值。日志不包含用户原文、系统提示词或工具实参，是否在终端显示由日志级别和 handler 决定。

近似计数不能当作 Qwen 精确 tokenizer：当前 ChatOllama 的基类计数还会忽略工具 schema，因此本项目使用支持工具定义的内置近似函数，并明确保留误差余量。`chars_per_token` 与余量不能提供严格不超窗保证；严格计数需要匹配模型 tokenizer 和实际聊天模板。

将来 UI 展示应区分两种信息：

| 信息 | 来源与含义 |
| --- | --- |
| 本次上下文预计占用/剩余 | 调用前的近似预算，需标注“估算” |
| 整轮输入、输出 token 与耗时 | 各次模型响应的实际统计按请求累计，包含工具循环中的多次调用 |

这需要单独扩展返回协议、按 `request_id` 保存统计并在回放时复用，不能只展示最后一次模型调用，或把估算冒充实际消耗。本次没有新增 UI 字段、用量持久化或累计计费逻辑。

## 失败与停止等待

所有请求通过 `api.js` 统一控制超时：模型列表、会话列表、详情、历史、新建会话和请求状态查询默认每次 10 秒；聊天请求默认 120 秒。内部调用可通过 `timeoutMs` 覆盖为有限正数。上限覆盖发送请求及读取 JSON 响应体；串行读取多个接口时，每次请求分别计时。

请求结束后会清理定时器和外部取消监听器。`ChatApiError.code` 使用 `TIMEOUT`、`ABORTED` 等本地分类区分超时和用户停止；HTTP 错误仍保留原状态码及后端的公开说明。这些本地分类不要求后端增加响应字段。

点击“停止等待”或等待超过两分钟，只会中止浏览器等待；后端可能已经执行或仍在处理。页面保留原请求和输入，显示“查询结果”“重试原消息”，由用户决定恢复操作，不自动重发。

会话或历史读取超时会结束加载并保留已有消息和草稿。聊天回复已收到但历史同步超时时，保留本轮回复并允许后续操作，提示稍后刷新确认，不把已成功收到的输入重新放回草稿。

新建会话失败时，后端可能已经完成创建，页面提示先刷新列表确认。本页会记住这次结果未知的创建，后续刷新即使得到空列表也不会自动再创建；用户仍可明确点击新建。这个标记仅在当前页面内保留，刷新整个页面或跨浏览器后的去重需要后续请求幂等协议。

网络失败或响应丢失时，后端可能已经保存部分或全部消息。历史读取不能证明请求一定完成或一定取消，应通过请求 ID 查询。查询 404、失败或超时仍保留原 ID；404 可以显式同 ID 重试，`processing` 继续查询，`failed` 展示原错误。`succeeded` 展示真实回复并同步历史；历史暂不可用时保留回复和“继续聊天”入口，不重新运行模型。

本次前端接入无需修改后端路径、请求字段或响应格式。后端现有的模型网络超时、天气请求超时和数据库连接池等待上限继续生效；它们与浏览器等待上限分别计时，不能视为整轮聊天的执行总时限。浏览器停止等待也不保证后端立即释放锁或停止 Agent。

## Python 第三方类型声明

`src/common/third_party_types.py` 集中声明真实 SDK 的类型别名，Agent 工厂返回值、相关形参及从 `app.state` 取出的局部变量已接入类型提示。它只帮助静态分析和代码导航，不替换模型，也不改变第三方运行时实现。

在 VS Code 中选择解释器 `D:\conda_env\langchain\python.exe`，输入 `agent.` 后可用 `Ctrl+Space` 查看补全，用 `F12` 跳转。Agent 的 `invoke` 实现继承自 `Pregel`，跳转到父类是正常行为。

当前聊天调用通过状态输入与 `thread_id` 接入 Agent；网页历史使用相同的会话 ID 读取独立业务档案。类型提示仍只帮助编辑器，真实数据库、模型和工具执行能力需要独立联调。

## 验证

从项目根目录执行：

```powershell
node --test web_ui/tests/api.test.js web_ui/tests/request_state.test.js web_ui/tests/ui.test.js
node --check web_ui/app.js
node --check web_ui/api.js
node --check web_ui/request_state.js
& 'D:\conda_env\langchain\python.exe' -B -m unittest discover -s src/test -p 'test_*.py' -v
```

Node.js 只用于测试。前端 106 项测试通过，包含 API、请求存储和轻量 DOM 驱动的实际 `app.js`，覆盖原有历史与超时行为、新 ID 生成、先保存再发送、同 ID 重试、三态恢复、404、状态查询超时、结果回放不重复显示、终态写入或重新查询失败仍保留已知结果及多会话隔离。测试不调用真实数据库或模型，生产页面也不使用测试夹具；测试通过不等于真实持久化和模型联调已经完成。

服务启动后打开 [消息布局回归测试](http://127.0.0.1:6576/tests/layout.test.html)，页面会在 320、390、1280、1920px 四种视口中加载实际前端，检查用户消息靠右且为绿色、AI 消息靠左且为白色，以及长文本、代码块和等待回复时的布局。测试 iframe 隔离 API 和浏览器存储，不读写真实聊天记录或已选会话。

后端隔离测试 156 项通过，覆盖实际 FastAPI 的聊天请求、独立档案读取、同连接事务编排、上下文配置与临时选择、错误与锁行为、模型配置校验、只读列表和启动加载，以及天气工具错误处理；隔离真实数据库、模型和天气 HTTP 调用。默认发现共 164 项，其中 8 项真实数据库测试跳过，需要显式开启。

上下文新增 17 项配置/选择单元测试和 7 项真实 LangChain 图集成测试。后者使用测试模型与工具、`InMemorySaver` 驱动实际 `create_agent`，验证跨轮输入缩短、原状态和消息 ID 保留、工具返回后再次选择、当前问题/工具结果/system/工具定义超限时不继续调用模型，以及会话隔离。另适配模型参数、启动校验、错误保存回放和 HTTP 契约测试。生产模型仍是 ChatOllama，没有替换为测试模型。

本次另在 PostgreSQL 18.6 上完成 8 项集成测试，使用真实 Store、SQL 和约束，覆盖成功回放、归档约束失败、终态更新后抛错/零行更新的回滚、旧调用与会话隔离、成功请求回填和重复初始化。每项都使用随机隔离 schema 和外层强制回滚，并检查 schema 已消失；没有初始化正式 `chat_messages` 或修改已有聊天记录。这证明 SQL 和事务回滚行为，不等同独立连接提交可见性、真实模型或浏览器端到端联调。

如需重复运行真实数据库验证，先启动配置中的 PostgreSQL，再执行：

```powershell
$env:CHAT_TEST_POSTGRES = '1'
try {
    & 'D:\conda_env\langchain\python.exe' -B -m unittest src.test.test_message_store_postgres -v
} finally {
    Remove-Item Env:CHAT_TEST_POSTGRES -ErrorAction SilentlyContinue
}
```

真实联调可在 A 会话发送一段内容，切到 B 确认互不混入，再切回 A、刷新整个页面，确认服务端历史可恢复。随后重启后端再次读取 A；还应验证空会话和查询失败时的提示。当前历史未提供消息时间，页面不应出现虚构的历史时间。

本次升级后先重启后端，让启动流程初始化 `chat_messages` 并回填旧成功请求，确认连接到预期数据库。浏览器开发者工具的 Network 中应看到 POST 带 `request_id`；发送后停止等待，再查询结果或重开页面，应出现 GET 状态查询，同 ID 重试的正文与 ID 应保持一致，模型不重复执行。历史接口应返回业务消息 UUID，重复刷新不增加记录。这些真实浏览器与 Ollama 验证仍需实际运行。

上下文配置已用真实配置、系统提示词与工具定义执行离线检查：总估算输入预算 6656，ChatOllama 构造参数为 `num_ctx=8192/num_predict=1024`；长历史被排除而原列表保留。未触发真实 Ollama 生成或模型加载，尚未验证实际显存开销、生成完整性与教学质量。服务使用新配置生成后，可用 `ollama ps` 核对实际运行窗口，再比较长对话的输入统计、耗时和近期指代接续效果。

头像与欢迎页使用 `assets/teresa.png`。回复支持基础加粗、行内代码和代码块，其余 Markdown 按普通文字显示；模型内容只创建文本节点，不执行返回的 HTML。
