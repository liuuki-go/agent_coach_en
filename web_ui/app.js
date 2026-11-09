import { createSession, getChatRequestStatus, getModelList, getSession, getSessionMessages, listSessions, sendChat } from "./api.js?v=request-id-1";
import { createChatRequest, getChatRequests, removeChatRequest, saveChatRequest } from "./request_state.js?v=request-id-1";

const $ = (selector) => document.querySelector(selector);
const input = $("#message-input");
const messageList = $("#message-list");
const threads = [];
let activeThread;
let pending = null;
let loading = false;
let creationUncertain = false;
let toastTimer;
const ACTIVE_SESSION_KEY = "teresa.activeSessionId";

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function notify(text) {
  const toast = $("#toast");
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#sidebar-scrim").hidden = true;
  $("#menu-toggle").setAttribute("aria-expanded", "false");
}

function showError(text) {
  const alert = $("#chat-error");
  alert.textContent = text;
  alert.hidden = !text;
}

function closeModelMenu() {
  $("#model-menu").hidden = true;
  $("#model-menu-toggle").setAttribute("aria-expanded", "false");
}

async function loadModelList() {
  const button = $("#model-menu-toggle");
  const label = $("#model-label");
  const status = $("#model-status");
  button.disabled = true;
  label.textContent = "正在读取模型…";
  try {
    const catalog = await getModelList();
    const current = catalog.models.find((model) => model.name === catalog.default);
    label.textContent = current.displayName;
    const items = catalog.models.map((model) => {
      const item = document.createElement("li");
      item.className = "model-item";
      const description = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = model.displayName;
      const identifier = document.createElement("span");
      identifier.textContent = model.name;
      description.append(name, identifier);
      item.append(description);
      if (model.name === catalog.default) {
        item.classList.add("current");
        item.setAttribute("aria-current", "true");
        const check = document.createElement("span");
        check.className = "model-check";
        check.textContent = "✓";
        check.setAttribute("aria-label", "当前默认模型");
        item.append(check);
      }
      return item;
    });
    $("#model-list").replaceChildren(...items);
    button.disabled = false;
    status.textContent = "";
    status.hidden = true;
  } catch (error) {
    label.textContent = "模型列表不可用";
    status.textContent = `模型列表读取失败：${error.message} 聊天仍可使用服务端默认模型。`;
    status.hidden = false;
    closeModelMenu();
  }
}

function savedSessionId() {
  try { return localStorage.getItem(ACTIVE_SESSION_KEY); } catch { return null; }
}

function rememberSession(id) {
  try { localStorage.setItem(ACTIVE_SESSION_KEY, id); } catch { /* 会话列表仍可从后端读取。 */ }
}

function upsertThread(session) {
  let thread = threads.find((item) => item.id === session.id);
  if (thread) {
    Object.assign(thread, session);
  } else {
    thread = { ...session, messages: [], draft: "", historyAvailable: false, request: null, requestNote: "" };
    threads.push(thread);
  }
  threads.sort((left, right) => right.updatedAt - left.updatedAt);
  return thread;
}

async function refreshThread(thread) {
  const session = await getSession(thread.id);
  upsertThread(session);
  const savedRequest = getChatRequests(thread.id)[0] ?? null;
  // 本地终态更新可能写入失败，不能用磁盘中的 pending 覆盖已收到的结果。
  if (!thread.request || thread.request.status === "pending") thread.request = savedRequest;
  if (thread.request && !thread.draft) thread.draft = thread.request.content;
  let historyFailed = false;
  try {
    thread.messages = await getSessionMessages(thread.id);
    thread.historyAvailable = true;
  } catch (error) {
    if (!thread.request) throw error;
    historyFailed = true;
    showError(`历史读取失败：${error.message} 可以继续查询上次发送的结果。`);
  }
  await recoverThreadRequest(thread, { historyLoaded: !historyFailed, historyFailed });
}

function updateThreadRequest(thread, changes) {
  thread.request = { ...thread.request, ...changes };
  try {
    saveChatRequest(thread.request);
  } catch (error) {
    // 原 ID 在发送前已保存；更新失败仍保留已知结果，不恢复成未发送。
    showError(`回复状态已收到，但本地记录更新失败：${error.message} 请稍后查询确认。`);
  }
}

function finishThreadRequest(thread) {
  const completed = thread.request;
  try {
    removeChatRequest(completed.requestId);
    thread.request = getChatRequests(thread.id)[0] ?? null;
    thread.requestNote = "";
    if (completed.status === "succeeded" && thread.draft === completed.content) thread.draft = "";
    if (thread.request && !thread.draft) thread.draft = thread.request.content;
    return true;
  } catch (error) {
    showError(`发送结果已确认，但本地记录尚未清理：${error.message}`);
    return false;
  }
}

function historyShowsRequest(thread) {
  const record = thread.request;
  // 完成状态已由聊天响应或 ID 查询确认；此处仅判断是否还需展示已知回复。
  return thread.messages.some((message, index, messages) => message.role === "user"
    && message.content === record.content && messages[index + 1]?.role === "assistant"
    && messages[index + 1].content === record.reply);
}

function noteUnsyncedReply(thread) {
  thread.requestNote = "本次发送已完成，但历史暂未同步。回复仍保留，可再次查询或继续聊天。";
  showError("回复已收到，但已保存的历史暂未包含本轮回复。当前回复仍保留在页面，请稍后刷新确认。");
}

function settleSuccessfulRequest(thread) {
  if (historyShowsRequest(thread)) finishThreadRequest(thread);
  else noteUnsyncedReply(thread);
}

async function syncSuccessfulRequest(thread) {
  try {
    const messages = await getSessionMessages(thread.id);
    const previous = thread.messages;
    thread.messages = messages;
    if (historyShowsRequest(thread)) {
      thread.historyAvailable = true;
      finishThreadRequest(thread);
    } else {
      // 保留本页即时显示的回复；恢复查询则只展示已保存历史和结果面板。
      if (previous.some((message) => message.requestId === thread.request.requestId)) thread.messages = previous;
      noteUnsyncedReply(thread);
    }
  } catch (error) {
    thread.requestNote = "本次发送已完成，历史同步暂时不可用。可以再次查询或继续聊天。";
    showError(`回复已收到，但历史同步失败：${error.message} 当前回复仍保留在页面，请稍后刷新确认。`);
  }
}

async function recoverThreadRequest(thread, { historyLoaded = false, historyFailed = false, force = false } = {}) {
  if (!thread.request) return;
  if (thread.request.status === "pending" || force) {
    try {
      const result = await getChatRequestStatus(thread.id, thread.request.requestId);
      if (result.status === "processing") {
        thread.requestNote = "上次发送仍在处理中，请稍后查询；重试会沿用同一次发送。";
        return;
      }
      if (result.status === "succeeded") {
        updateThreadRequest(thread, { status: "succeeded", reply: result.reply });
      } else {
        updateThreadRequest(thread, { status: "failed", error: result.error });
      }
    } catch (error) {
      if (thread.request.status === "succeeded") {
        thread.requestNote = "本次发送已完成，已收到的回复仍保留；暂时无法重新查询，请稍后再试。";
      } else if (thread.request.status === "failed") {
        thread.requestNote = `上次发送已确认失败：${thread.request.error.message} 暂时无法重新查询，可以开始新消息。`;
      } else {
        thread.requestNote = error.status === 404
          ? "暂未找到本次发送记录。可以重试原消息，系统会沿用原发送标识。"
          : "上次发送结果暂时无法确认，请稍后查询或重试原消息。";
      }
      showError(`${error.message} ${thread.requestNote}`);
      return;
    }
  }
  if (thread.request.status === "succeeded") {
    if (historyLoaded) settleSuccessfulRequest(thread);
    else if (!historyFailed) await syncSuccessfulRequest(thread);
    else thread.requestNote = "本次发送已完成，回复已恢复；历史暂时不可用，可以稍后查询或继续聊天。";
  } else if (thread.request.status === "failed") {
    thread.requestNote = `上次发送已失败：${thread.request.error.message} 可以开始新消息后编辑发送。`;
    showError(thread.requestNote);
  }
}

async function requestNewSession() {
  try {
    const session = await createSession();
    creationUncertain = false;
    return session;
  } catch (error) {
    // 新建是写操作；响应丢失后，本页刷新不能再自动创建一次。
    creationUncertain = true;
    throw new Error(`${error.message} 后端可能已创建会话，请先刷新列表确认；再次新建可能产生重复会话。`);
  }
}

async function selectThread(thread) {
  if (pending || loading) return;
  if (activeThread) activeThread.draft = input.value;
  loading = true;
  showError("");
  render();
  try {
    await refreshThread(thread);
    activeThread = thread;
    rememberSession(thread.id);
    input.value = thread.draft;
    closeSidebar();
  } catch (error) {
    showError(error.message);
  } finally {
    loading = false;
    render();
    input.focus();
  }
}

async function newThread() {
  if (pending || loading) return;
  if (activeThread) activeThread.draft = input.value;
  loading = true;
  showError("");
  render();
  try {
    const session = await requestNewSession();
    activeThread = upsertThread(session);
    activeThread.historyAvailable = true;
    rememberSession(session.id);
    input.value = "";
    closeSidebar();
  } catch (error) {
    showError(error.message);
  } finally {
    loading = false;
    render();
    input.focus();
  }
}

async function reloadThreads() {
  if (pending || loading) return;
  if (activeThread) activeThread.draft = input.value;
  loading = true;
  showError("");
  render();
  try {
    const sessions = await listSessions();
    const ids = new Set(sessions.map((session) => session.id));
    for (let index = threads.length - 1; index >= 0; index--) {
      if (!ids.has(threads[index].id)) threads.splice(index, 1);
    }
    sessions.forEach(upsertThread);
    if (threads.length === 0) {
      if (creationUncertain) {
        throw new Error("上次新建会话的结果尚未确认，后端可能已创建会话。请稍后刷新列表确认，再决定是否重新新建。");
      }
      upsertThread(await requestNewSession());
    }
    const preferredId = activeThread?.id ?? savedSessionId();
    const thread = threads.find((item) => item.id === preferredId) ?? threads[0];
    await refreshThread(thread);
    activeThread = thread;
    rememberSession(thread.id);
    input.value = thread.draft;
  } catch (error) {
    showError(error.message);
  } finally {
    loading = false;
    render();
  }
}

function renderThreads() {
  const list = $("#thread-list");
  list.replaceChildren();
  $("#thread-count").textContent = String(threads.length).padStart(2, "0");
  for (const thread of threads) {
    const button = document.createElement("button");
    button.className = `thread-button${thread === activeThread ? " active" : ""}`;
    button.disabled = Boolean(pending) || loading;
    if (thread === activeThread) button.setAttribute("aria-current", "page");
    const name = document.createElement("span");
    name.className = "thread-name";
    name.textContent = thread.title;
    button.append(icon("chat"), name);
    button.addEventListener("click", () => selectThread(thread));
    list.append(button);
  }
}

// 仅创建文本节点，模型返回的 HTML 不会作为页面代码执行。
function appendInlineText(parent, text) {
  for (const part of text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      parent.append(strong);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}

function renderContent(parent, content) {
  const parts = content.split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const part of parts) {
    if (/^```[^\n]*\n[\s\S]*```$/.test(part)) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = part.slice(part.indexOf("\n") + 1, -3);
      pre.append(code);
      parent.append(pre);
    } else {
      appendInlineText(parent, part);
    }
  }
}

function renderMessage(message, isTyping = false) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  if (message.role === "assistant") {
    const image = document.createElement("img");
    image.src = "./assets/teresa.png";
    image.alt = "";
    avatar.append(image);
  } else {
    avatar.textContent = "你";
  }
  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.textContent = message.role === "assistant" ? "Teresa" : "你";
  meta.append(name);
  if (message.createdAt instanceof Date) {
    const time = document.createElement("time");
    time.dateTime = message.createdAt.toISOString();
    time.textContent = message.createdAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    meta.append(time);
  }
  const content = document.createElement("div");
  content.className = "message-content";
  if (isTyping) {
    const typing = document.createElement("div");
    typing.className = "typing";
    for (let i = 0; i < 3; i++) typing.append(document.createElement("i"));
    const label = document.createElement("span");
    label.textContent = "正在等待回复…";
    typing.append(label);
    content.append(typing);
  } else {
    renderContent(content, message.content);
  }
  body.append(meta, content);
  if (!isTyping && message.role === "assistant") {
    const copy = document.createElement("button");
    copy.className = "copy-button";
    copy.append(icon("copy"), document.createTextNode("复制回复"));
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.content);
        notify("回复已复制");
      } catch {
        notify("暂时无法复制，请选择文字后手动复制。");
      }
    });
    body.append(copy);
  }
  article.append(avatar, body);
  return article;
}

function canSend() {
  const text = input.value.trim();
  if (pending || loading || !activeThread || !text) return false;
  const record = activeThread.request;
  return !record || (record.status === "pending" && text === record.content);
}

function render() {
  const busy = Boolean(pending) || loading;
  $("#new-chat").disabled = busy;
  $("#reload-history").disabled = busy;
  $("#send-button").hidden = Boolean(pending);
  $("#send-button").disabled = !canSend();
  $("#stop-button").hidden = !pending;
  input.disabled = busy || !activeThread;
  const record = activeThread?.request;
  $("#request-recovery").hidden = !record || Boolean(pending);
  $("#request-note").textContent = record
    ? activeThread.requestNote || "上次发送的结果还未确认，可以查询结果或重试原消息。"
    : "";
  const replyShown = record && activeThread.messages.some((message) => message.requestId === record.requestId && message.role === "assistant");
  $("#request-result").hidden = record?.status !== "succeeded" || replyShown;
  $("#request-result").textContent = record?.status === "succeeded" && !replyShown ? record.reply : "";
  $("#check-request").disabled = busy || !record;
  $("#retry-request").hidden = record?.status !== "pending";
  $("#retry-request").disabled = busy || !record;
  $("#new-request").hidden = !record || record.status === "pending";
  $("#new-request").disabled = busy || !record;
  $("#new-request").textContent = record?.status === "succeeded" ? "继续聊天" : "开始新消息";
  renderThreads();
  const history = activeThread?.messages ?? [];
  const messages = pending && !pending.retry ? [...history, pending.user] : history;
  $("#welcome").hidden = messages.length > 0;
  messageList.hidden = messages.length === 0;
  messageList.setAttribute("aria-busy", String(busy));
  $("#history-note").textContent = activeThread
    ? loading ? "正在读取会话和历史消息…" : "切换会话或刷新页面会重新读取已保存的消息。"
    : loading ? "正在读取会话和历史消息…" : "请选择会话后开始聊天。";
  messageList.replaceChildren(...messages.map((message) => renderMessage(message)));
  if (pending) {
    messageList.append(renderMessage({ role: "assistant", createdAt: new Date() }, true));
  }
  resizeInput();
  const scroll = $("#conversation-scroll");
  scroll.scrollTop = messages.length ? scroll.scrollHeight : 0;
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

async function submitChatRequest(thread, record, { retry = false } = {}) {
  try {
    // 发送前先持久化原 ID 和原文；保存失败时本次尝试不发出网络请求。
    saveChatRequest(record);
  } catch (error) {
    showError(`无法保存本次发送：${error.message} 本次尝试尚未发出。`);
    render();
    return;
  }
  const remainingDraft = input.value.trim() === record.content ? "" : input.value;
  const request = {
    user: { role: "user", content: record.content, requestId: record.requestId, createdAt: new Date() },
    controller: new AbortController(),
    stopReason: "",
    retry,
  };
  thread.request = record;
  thread.requestNote = "";
  pending = request;
  input.value = "";
  thread.draft = remainingDraft;
  showError("");
  render();
  try {
    const reply = await sendChat(thread.id, record.content, {
      requestId: record.requestId, signal: request.controller.signal,
    });
    updateThreadRequest(thread, { status: "succeeded", reply });
    // 重试可能回放已存在的回复，优先同步历史，避免再次追加同一轮。
    if (!retry && !thread.messages.some((message) => message.requestId === record.requestId)) {
      thread.messages.push(request.user, {
        role: "assistant", content: reply, requestId: record.requestId, createdAt: new Date(),
      });
    }
    pending = null;
    loading = true;
    render();
    await syncSuccessfulRequest(thread);
  } catch (error) {
    if (!thread.draft) thread.draft = record.content;
    showError(error.code === "TIMEOUT"
      ? "等待超过两分钟，后端可能仍在处理。已保留本次发送，可以查询结果或重试同一次发送。"
      : error.code === "ABORTED" && request.stopReason === "user"
        ? "已停止等待，后端可能仍在处理。已保留本次发送，可以查询结果或重试原消息。"
        : `${error.message} 后端可能已执行。已保留原发送标识和内容，请查询结果或重试原消息。`);
  } finally {
    pending = null;
    loading = false;
    input.value = thread.draft;
    render();
    input.focus();
  }
}

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (pending || loading || !activeThread || !text) return;
  const thread = activeThread;
  try {
    thread.request ??= getChatRequests(thread.id)[0] ?? null;
    if (thread.request) {
      if (thread.request.status !== "pending") {
        showError("上次发送已有结果，请先继续聊天或开始新消息。");
        render();
        return;
      }
      if (text !== thread.request.content) {
        showError("上一条发送尚未确认，不能更换原消息重试。请先查询结果，或点击重试原消息。");
        render();
        return;
      }
      await submitChatRequest(thread, thread.request, { retry: true });
    } else {
      const record = createChatRequest(thread.id, text);
      thread.request = record;
      await submitChatRequest(thread, record);
    }
  } catch (error) {
    showError(`无法开始发送：${error.message} 消息尚未发送。`);
    render();
  }
});

$("#check-request").addEventListener("click", async () => {
  if (pending || loading || !activeThread?.request) return;
  const thread = activeThread;
  thread.draft = input.value;
  loading = true;
  showError("");
  render();
  try {
    await recoverThreadRequest(thread, { force: true });
  } finally {
    loading = false;
    input.value = thread.draft;
    render();
    input.focus();
  }
});

$("#retry-request").addEventListener("click", async () => {
  if (pending || loading || activeThread?.request?.status !== "pending") return;
  await submitChatRequest(activeThread, activeThread.request, { retry: true });
});

$("#new-request").addEventListener("click", () => {
  if (pending || loading || !activeThread?.request || activeThread.request.status === "pending") return;
  activeThread.draft = input.value;
  showError("");
  finishThreadRequest(activeThread);
  input.value = activeThread.draft;
  render();
  input.focus();
});

input.addEventListener("input", () => {
  if (!activeThread) return;
  activeThread.draft = input.value;
  $("#send-button").disabled = !canSend();
  resizeInput();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
$("#stop-button").addEventListener("click", () => {
  if (!pending) return;
  pending.stopReason = "user";
  pending.controller.abort();
});
$("#new-chat").addEventListener("click", () => newThread());
$("#reload-history").addEventListener("click", () => reloadThreads());
$("#menu-toggle").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#sidebar-scrim").hidden = !open;
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
});
$("#sidebar-scrim").addEventListener("click", closeSidebar);
$("#model-menu-toggle").addEventListener("click", () => {
  const open = $("#model-menu").hidden;
  $("#model-menu").hidden = !open;
  $("#model-menu-toggle").setAttribute("aria-expanded", String(open));
});
document.addEventListener("pointerdown", (event) => {
  if (!$("#model-selector").contains(event.target)) closeModelMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSidebar();
    if (!$("#model-menu").hidden) {
      closeModelMenu();
      $("#model-menu-toggle").focus();
    }
  }
});

render();
export const ready = reloadThreads();
export const modelsReady = loadModelList();
