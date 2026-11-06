export const CHAT_ENDPOINT = "/api/chat";
export const SESSION_LIST_ENDPOINT = "/api/sessions/getAllSessions";
export const SESSION_DETAIL_ENDPOINT = "/api/sessions/getSessionById";
export const SESSION_CREATE_ENDPOINT = "/api/sessions/createSession";
export const SESSION_MESSAGES_ENDPOINT = "/api/sessions/getSessionMessages";

export class ChatApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ChatApiError";
    this.status = status;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ChatApiError("会话标识无效，请重新加载会话。");
  }
  return value;
}

function parseDate(value) {
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.getTime())) {
    throw new ChatApiError("接口返回的会话时间无效。");
  }
  return date;
}

function parseSession(session) {
  if (typeof session?.title !== "string") {
    throw new ChatApiError("接口没有返回有效的会话信息。");
  }
  return {
    id: requireId(session.id),
    title: session.title,
    createdAt: parseDate(session.created_at),
    updatedAt: parseDate(session.updated_at),
  };
}

async function requestJson(url, { method = "GET", body, signal, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    throw new ChatApiError(`接口返回了无效 JSON（HTTP ${response.status}）。`, response.status);
  }
  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : data?.error;
    throw new ChatApiError(
      typeof detail === "string" ? detail : `请求失败（HTTP ${response.status}）。`,
      response.status,
    );
  }
  return data;
}

export async function listSessions(options = {}) {
  const data = await requestJson(SESSION_LIST_ENDPOINT, options);
  if (!Array.isArray(data)) throw new ChatApiError("接口没有返回有效的会话列表。");
  return data.map(parseSession);
}

export async function createSession(options = {}) {
  const data = await requestJson(SESSION_CREATE_ENDPOINT, { ...options, method: "POST", body: {} });
  return parseSession(data?.session_id);
}

export async function getSession(sessionId, options = {}) {
  const data = await requestJson(SESSION_DETAIL_ENDPOINT, {
    ...options, method: "POST", body: { session_id: requireId(sessionId) },
  });
  const session = parseSession(data);
  if (session.id !== sessionId) throw new ChatApiError("接口返回的会话信息不匹配。");
  return session;
}

export async function getSessionMessages(sessionId, options = {}) {
  const data = await requestJson(SESSION_MESSAGES_ENDPOINT, {
    ...options, method: "POST", body: { session_id: requireId(sessionId) },
  });
  if (!Array.isArray(data)) throw new ChatApiError("接口没有返回有效的历史消息列表。");
  return data.map((message) => {
    if (!message || !["user", "assistant"].includes(message.role)
      || typeof message.content !== "string" || !message.content.trim()
      || (message.id !== null && message.id !== undefined && typeof message.id !== "string")) {
      throw new ChatApiError("接口返回的历史消息格式无效。");
    }
    return { id: message.id ?? null, role: message.role, content: message.content };
  });
}

export function buildChatRequest(sessionId, content) {
  if (typeof content !== "string" || !content.trim()) {
    throw new ChatApiError("消息内容不能为空。");
  }
  if (content.trim().length > 12000) throw new ChatApiError("消息内容不能超过 12000 个字符。");
  return { session_id: requireId(sessionId), content: content.trim() };
}

export async function sendChat(sessionId, content, options = {}) {
  const body = buildChatRequest(sessionId, content);
  const data = await requestJson(CHAT_ENDPOINT, { ...options, method: "POST", body });
  const reply = typeof data === "string" ? data : data?.reply;
  if (typeof reply !== "string" || !reply.trim()) {
    throw new ChatApiError("接口没有返回有效的文字回复。");
  }
  return reply;
}
