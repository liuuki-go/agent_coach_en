const REQUEST_PREFIX = "teresa.chatRequest.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value, name) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${name}无效，无法保存或恢复聊天请求。`);
  }
}

function requireContent(content) {
  if (typeof content !== "string" || !content.trim() || content.length > 12000) {
    throw new Error("聊天请求内容无效，内容必须为不超过 12000 字符的非空文字。");
  }
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("聊天请求记录已损坏，无法安全恢复。请保留当前记录。");
  }
  requireId(record.requestId, "请求标识");
  requireId(record.sessionId, "会话标识");
  requireContent(record.content);
  if (record.content !== record.content.trim()) {
    throw new Error("聊天请求内容与实际发送文字不一致，无法安全恢复。");
  }
  const created = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
  if (!Number.isFinite(created) || new Date(created).toISOString() !== record.createdAt) {
    throw new Error("聊天请求创建时间无效，无法安全恢复。");
  }
  if (!["pending", "succeeded", "failed"].includes(record.status)) {
    throw new Error("聊天请求状态无效，无法安全恢复。");
  }

  // 只保存恢复当前请求所需的字段，不把完整聊天历史或其他对象写入浏览器。
  const saved = {
    requestId: record.requestId,
    sessionId: record.sessionId,
    content: record.content,
    status: record.status,
    createdAt: record.createdAt,
  };
  if (record.status === "succeeded") {
    if (typeof record.reply !== "string" || !record.reply.trim() || record.error != null) {
      throw new Error("成功请求缺少有效回复或包含冲突错误，无法安全恢复。");
    }
    saved.reply = record.reply;
  } else if (record.status === "failed") {
    if (record.reply != null || !record.error || typeof record.error !== "object" || Array.isArray(record.error)
      || typeof record.error.code !== "string" || !record.error.code.trim()
      || typeof record.error.message !== "string" || !record.error.message.trim()) {
      throw new Error("失败请求缺少有效错误说明或包含冲突回复，无法安全恢复。");
    }
    saved.error = { code: record.error.code, message: record.error.message };
  } else if (record.reply != null || record.error != null) {
    throw new Error("未确认请求包含冲突结果，无法安全恢复。");
  }
  return saved;
}

function getStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error("Storage unavailable");
    return storage;
  } catch {
    throw new Error("无法访问浏览器请求记录，请检查浏览器存储权限后重试。");
  }
}

function readRecord(storage, key) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    throw new Error("无法读取浏览器请求记录，当前请求状态仍需确认。");
  }
  if (raw === null) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error("浏览器聊天请求记录不是有效 JSON，请保留记录并检查后重试。");
  }
  const saved = validateRecord(record);
  if (key !== `${REQUEST_PREFIX}${saved.requestId}`) {
    throw new Error("浏览器聊天请求记录与请求标识不匹配，无法安全恢复。");
  }
  return saved;
}

export function createChatRequest(sessionId, content) {
  requireId(sessionId, "会话标识");
  if (typeof content !== "string") requireContent(content);
  const text = content.trim();
  requireContent(text);
  let requestId;
  try {
    requestId = globalThis.crypto.randomUUID();
  } catch {
    throw new Error("当前浏览器无法安全生成请求标识，请使用支持 crypto.randomUUID 的浏览器。");
  }
  const record = validateRecord({
    requestId, sessionId, content: text, status: "pending", createdAt: new Date().toISOString(),
  });
  if (readRecord(getStorage(), `${REQUEST_PREFIX}${requestId}`) !== null) {
    throw new Error("请求标识已经存在，请保留已有请求并确认状态。");
  }
  // 持久化成功后才能发送网络请求，页面重开后才能继续使用同一个 ID。
  saveChatRequest(record);
  return record;
}

export function saveChatRequest(record) {
  const saved = validateRecord(record);
  const storage = getStorage();
  const key = `${REQUEST_PREFIX}${saved.requestId}`;
  const previous = readRecord(storage, key);
  if (previous) {
    if (previous.sessionId !== saved.sessionId || previous.content !== saved.content
      || previous.createdAt !== saved.createdAt) {
      throw new Error("同一请求标识的会话、内容和创建时间不能更改。");
    }
    if (previous.status !== "pending" && JSON.stringify(previous) !== JSON.stringify(saved)) {
      throw new Error("已经确认的请求结果不能修改或退回未确认状态。");
    }
  }
  try {
    storage.setItem(key, JSON.stringify(saved));
  } catch {
    throw new Error("无法保存浏览器请求记录，请勿发送或更换请求标识。");
  }
}

export function getChatRequests(sessionId) {
  requireId(sessionId, "会话标识");
  const storage = getStorage();
  const keys = [];
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (typeof key === "string" && key.startsWith(REQUEST_PREFIX)) keys.push(key);
    }
  } catch {
    throw new Error("无法读取浏览器请求记录列表，请检查存储权限后重试。");
  }
  return keys.map((key) => readRecord(storage, key))
    .filter((record) => record !== null && record.sessionId === sessionId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.requestId.localeCompare(right.requestId));
}

export function removeChatRequest(requestId) {
  requireId(requestId, "请求标识");
  try {
    getStorage().removeItem(`${REQUEST_PREFIX}${requestId}`);
  } catch {
    throw new Error("无法移除浏览器请求记录，请保留原请求标识后重试。");
  }
}
