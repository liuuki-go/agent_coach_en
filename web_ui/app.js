import { createSession, getModelList, getSession, getSessionMessages, listSessions, sendChat } from "./api.js?v=model-list-1";

const $ = (selector) => document.querySelector(selector);
const input = $("#message-input");
const messageList = $("#message-list");
const threads = [];
let activeThread;
let pending = null;
let loading = false;
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
    thread = { ...session, messages: [], draft: "", historyAvailable: false };
    threads.push(thread);
  }
  threads.sort((left, right) => right.updatedAt - left.updatedAt);
  return thread;
}

async function refreshThread(thread) {
  const session = await getSession(thread.id);
  const messages = await getSessionMessages(thread.id);
  upsertThread(session);
  thread.messages = messages;
  thread.historyAvailable = true;
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
    const session = await createSession();
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
    if (threads.length === 0) upsertThread(await createSession());
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

function render() {
  const busy = Boolean(pending) || loading;
  $("#new-chat").disabled = busy;
  $("#reload-history").disabled = busy;
  $("#send-button").hidden = Boolean(pending);
  $("#send-button").disabled = busy || !activeThread || !input.value.trim();
  $("#stop-button").hidden = !pending;
  input.disabled = busy || !activeThread;
  renderThreads();
  const history = activeThread?.messages ?? [];
  const messages = pending ? [...history, pending.user] : history;
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

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (pending || loading || !activeThread || !text) return;
  const thread = activeThread;
  const request = {
    user: { role: "user", content: text, createdAt: new Date() },
    controller: new AbortController(),
    stopReason: "",
  };
  pending = request;
  input.value = "";
  thread.draft = "";
  showError("");
  render();
  const timer = setTimeout(() => {
    request.stopReason = "timeout";
    request.controller.abort();
  }, 120000);
  try {
    const reply = await sendChat(thread.id, text, { signal: request.controller.signal });
    clearTimeout(timer);
    thread.messages.push(request.user, {
      role: "assistant", content: reply, createdAt: new Date(),
    });
    pending = null;
    loading = true;
    render();
    try {
      const messages = await getSessionMessages(thread.id);
      const last = messages.slice(-2);
      if (last[0]?.role === "user" && last[0].content === text
        && last[1]?.role === "assistant" && last[1].content === reply) {
        thread.messages = messages;
        thread.historyAvailable = true;
      } else {
        showError("回复已收到，但已保存的历史暂未包含本轮回复。当前回复仍保留在页面，请稍后刷新确认。");
      }
    } catch (error) {
      showError(`回复已收到，但历史同步失败：${error.message} 当前回复仍保留在页面，请稍后刷新确认。`);
    }
  } catch (error) {
    thread.draft = text;
    showError(request.stopReason === "timeout"
      ? "等待超过两分钟，后端可能仍在处理。消息已放回输入框，重新发送可能重复执行。"
      : request.stopReason === "user"
        ? "已停止等待，后端可能仍在处理。消息已放回输入框，重新发送可能重复执行。"
        : `${error.message} 消息已放回输入框，后端可能已执行，重新发送可能重复执行。`);
  } finally {
    clearTimeout(timer);
    pending = null;
    loading = false;
    input.value = thread.draft;
    render();
    input.focus();
  }
});

input.addEventListener("input", () => {
  if (!activeThread) return;
  activeThread.draft = input.value;
  $("#send-button").disabled = !input.value.trim();
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
