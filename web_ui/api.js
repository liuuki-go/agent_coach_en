// 对接 service/web_server.py：发送 { content: "..." }，后端补上 user 角色。
export const CHAT_ENDPOINT = "/api/chat";

export class ChatApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ChatApiError";
    this.status = status;
  }
}

export function buildChatRequest(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ChatApiError("请先输入一条消息。");
  }

  const message = messages.at(-1);
  if (message?.role !== "user") {
    throw new ChatApiError("最后一条消息应当来自用户。");
  }
  if (typeof message.content !== "string" || !message.content.trim()) {
    throw new ChatApiError("消息内容不能为空。");
  }
  // 当前后端仅接收单条消息，历史记录和 UI 字段保留在页面内。
  return { content: message.content };
}

export async function sendChat(messages, { signal, fetchImpl = globalThis.fetch } = {}) {
  const body = buildChatRequest(messages);
  let response;
  try {
    response = await fetchImpl(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || error.name === "AbortError") throw error;
    throw new ChatApiError("无法连接后端。请确认 Web UI 启动服务仍在运行。");
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const message = response.ok
      ? "接口需要返回 JSON 字符串，例如：\"你好\"。"
      : `聊天接口返回 HTTP ${response.status}。请确认已实现 POST /api/chat。`;
    throw new ChatApiError(message, response.status);
  }

  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : data?.error;
    throw new ChatApiError(
      typeof detail === "string" ? detail : `聊天请求失败（HTTP ${response.status}）。`,
      response.status,
    );
  }
  // FastAPI 直接 return 字符串时，response.json() 得到的就是字符串。
  const reply = typeof data === "string" ? data : data?.reply;
  if (typeof reply !== "string" || !reply.trim()) {
    throw new ChatApiError("接口没有返回有效回复，请检查后端 invoke() 的返回值。", response.status);
  }
  return reply;
}
