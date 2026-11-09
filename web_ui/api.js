export const CHAT_ENDPOINT = "/api/chat";
export const CHAT_REQUEST_STATUS_ENDPOINT = "/api/chat/requests";
export const SESSION_LIST_ENDPOINT = "/api/sessions/getAllSessions";
export const SESSION_DETAIL_ENDPOINT = "/api/sessions/getSessionById";
export const SESSION_CREATE_ENDPOINT = "/api/sessions/createSession";
export const SESSION_MESSAGES_ENDPOINT = "/api/sessions/getSessionMessages";
export const MODEL_LIST_ENDPOINT = "/api/models/getModelList";

export class ChatApiError extends Error {
  constructor(message, status = 0, code = "REQUEST_FAILED") {
    super(message);
    this.name = "ChatApiError";
    this.status = status;
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ChatApiError("会话标识无效，请重新加载会话。");
  }
  return value;
}

function requireRequestId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ChatApiError("请求标识无效，请确认请求 ID。");
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

function abortedError() {
  const error = new ChatApiError("已停止等待。", 0, "ABORTED");
  error.name = "AbortError";
  return error;
}

async function requestJson(url, {
  method = "GET", body, signal, fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ChatApiError("请求超时时间必须是有限正数。");
  }
  if (signal?.aborted) throw abortedError();

  const controller = new AbortController();
  let finished = false;
  let stopError;
  let rejectStopped;
  const stopped = new Promise((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error) => {
    if (finished) return;
    finished = true;
    stopError = error;
    rejectStopped(error);
    // 取消本地等待并中止 fetch，不代表后端已停止生成或写入历史。
    controller.abort();
  };
  const onAbort = () => stop(abortedError());
  signal?.addEventListener("abort", onAbort, { once: true });
  // 同一个 deadline 覆盖响应头和 JSON 读取，不在收到响应头后重新计时。
  const timer = setTimeout(() => stop(new ChatApiError("请求等待超时。", 0, "TIMEOUT")), timeoutMs);

  const readResponse = async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (stopError) throw stopError;
      finished = true;
      if (error?.name === "AbortError") throw abortedError();
      throw new ChatApiError("无法连接后端。请确认 Web UI 启动服务仍在运行。", 0, "NETWORK_ERROR");
    }
    if (stopError) throw stopError;

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (stopError) throw stopError;
      finished = true;
      if (error?.name === "AbortError") throw abortedError();
      throw new ChatApiError(`接口返回了无效 JSON（HTTP ${response.status}）。`, response.status, "INVALID_JSON");
    }
    if (stopError) throw stopError;
    finished = true;
    if (!response.ok) {
      const detail = typeof data?.detail === "string" ? data.detail : data?.error;
      throw new ChatApiError(
        typeof detail === "string" ? detail : `请求失败（HTTP ${response.status}）。`,
        response.status,
      );
    }
    return data;
  };

  try {
    // 即使 adapter 或 JSON promise 不响应 abort，也要结束本地等待。
    return await Promise.race([readResponse(), stopped]);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function listSessions(options = {}) {
  const data = await requestJson(SESSION_LIST_ENDPOINT, options);
  if (!Array.isArray(data)) throw new ChatApiError("接口没有返回有效的会话列表。");
  return data.map(parseSession);
}

export async function getModelList(options = {}) {
  const data = await requestJson(MODEL_LIST_ENDPOINT, { ...options, method: "GET", body: undefined });
  if (typeof data?.default !== "string" || !data.default.trim()
    || !Array.isArray(data.models) || data.models.length === 0) {
    throw new ChatApiError("接口没有返回有效的模型列表。");
  }
  const names = new Set();
  const models = data.models.map((model) => {
    if (typeof model?.name !== "string" || !model.name.trim()
      || typeof model.display_name !== "string" || !model.display_name.trim()
      || names.has(model.name)) {
      throw new ChatApiError("接口返回的模型信息无效。");
    }
    names.add(model.name);
    return { name: model.name, displayName: model.display_name };
  });
  if (!names.has(data.default)) throw new ChatApiError("默认模型不在配置列表中。");
  return { default: data.default, models };
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

export async function getChatRequestStatus(sessionId, requestId, options = {}) {
  const validSessionId = requireId(sessionId);
  const validRequestId = requireRequestId(requestId);
  const url = `${CHAT_REQUEST_STATUS_ENDPOINT}/${encodeURIComponent(validRequestId)}?session_id=${encodeURIComponent(validSessionId)}`;
  const data = await requestJson(url, { ...options, method: "GET", body: undefined });
  const returnedRequestId = requireRequestId(data?.request_id);
  const returnedSessionId = requireId(data?.session_id);
  if (returnedRequestId.toLowerCase() !== validRequestId.toLowerCase()
    || returnedSessionId.toLowerCase() !== validSessionId.toLowerCase()) {
    throw new ChatApiError("接口返回的请求信息不匹配。");
  }

  const { status, reply, error } = data;
  let valid;
  if (status === "succeeded") {
    valid = typeof reply === "string" && Boolean(reply.trim()) && error === null;
  } else if (status === "failed") {
    valid = reply === null && error !== null && typeof error === "object" && !Array.isArray(error)
      && typeof error.code === "string" && Boolean(error.code.trim())
      && typeof error.message === "string" && Boolean(error.message.trim());
  } else if (status === "processing") {
    valid = reply === null && error === null;
  }
  if (!valid) throw new ChatApiError("接口返回的请求状态格式无效。");
  return {
    requestId: returnedRequestId,
    sessionId: returnedSessionId,
    status,
    reply,
    error: error === null ? null : { code: error.code, message: error.message },
  };
}

export function buildChatRequest(sessionId, content, requestId) {
  if (typeof content !== "string" || !content.trim()) {
    throw new ChatApiError("消息内容不能为空。");
  }
  if (content.trim().length > 12000) throw new ChatApiError("消息内容不能超过 12000 个字符。");
  return {
    session_id: requireId(sessionId),
    content: content.trim(),
    ...(requestId === undefined ? {} : { request_id: requireRequestId(requestId) }),
  };
}

export async function sendChat(sessionId, content, options = {}) {
  const body = buildChatRequest(sessionId, content, options.requestId);
  const { timeoutMs = 120_000 } = options;
  const data = await requestJson(CHAT_ENDPOINT, { ...options, timeoutMs, method: "POST", body });
  const reply = typeof data === "string" ? data : data?.reply;
  if (typeof reply !== "string" || !reply.trim()) {
    throw new ChatApiError("接口没有返回有效的文字回复。");
  }
  return reply;
}
