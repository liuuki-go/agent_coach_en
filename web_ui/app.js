import { sendChat } from "./api.js";

const $ = (selector) => document.querySelector(selector);
const input = $("#message-input");
const messageList = $("#message-list");
const threads = [];
let activeThread;
let pending = null;
let toastTimer;

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

function newThread() {
  if (pending) return;
  if (activeThread && activeThread.messages.length === 0) {
    activeThread.draft = "";
  } else {
    activeThread = { id: crypto.randomUUID(), title: "新的英语时光", messages: [], draft: "" };
    threads.unshift(activeThread);
  }
  input.value = "";
  $("#chat-error").hidden = true;
  render();
  closeSidebar();
  input.focus();
}

function renderThreads() {
  const list = $("#thread-list");
  list.replaceChildren();
  $("#thread-count").textContent = String(threads.length).padStart(2, "0");
  for (const thread of threads) {
    const button = document.createElement("button");
    button.className = `thread-button${thread === activeThread ? " active" : ""}`;
    button.disabled = Boolean(pending);
    if (thread === activeThread) button.setAttribute("aria-current", "page");
    const name = document.createElement("span");
    name.className = "thread-name";
    name.textContent = thread.title;
    button.append(icon("chat"), name);
    button.addEventListener("click", () => {
      if (pending) return;
      activeThread.draft = input.value;
      activeThread = thread;
      input.value = thread.draft;
      $("#chat-error").hidden = true;
      render();
      closeSidebar();
      input.focus();
    });
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
  const time = document.createElement("time");
  time.dateTime = message.createdAt.toISOString();
  time.textContent = message.createdAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  meta.append(time);
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
  const busy = Boolean(pending);
  $("#new-chat").disabled = busy;
  $("#send-button").hidden = busy;
  $("#send-button").disabled = !input.value.trim();
  $("#stop-button").hidden = !busy;
  input.disabled = busy;
  renderThreads();
  const messages = pending ? [...activeThread.messages, pending.user] : activeThread.messages;
  $("#welcome").hidden = messages.length > 0;
  messageList.hidden = messages.length === 0;
  messageList.setAttribute("aria-busy", String(busy));
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
  if (pending || !text) return;
  const thread = activeThread;
  const request = {
    user: { role: "user", content: text, createdAt: new Date() },
    controller: new AbortController(),
    stopReason: "",
  };
  pending = request;
  input.value = "";
  thread.draft = "";
  $("#chat-error").hidden = true;
  render();
  const timer = setTimeout(() => {
    request.stopReason = "timeout";
    request.controller.abort();
  }, 120000);
  try {
    const reply = await sendChat([...thread.messages, request.user], { signal: request.controller.signal });
    // 只有请求成功才提交这一轮，失败重试不会重复发送用户消息。
    thread.messages.push(request.user, {
      role: "assistant", content: reply, createdAt: new Date(),
    });
    if (thread.messages.length === 2) thread.title = text.slice(0, 20);
  } catch (error) {
    thread.draft = text;
    input.value = text;
    const alert = $("#chat-error");
    alert.textContent = request.stopReason === "timeout"
      ? "等待超过两分钟。消息已放回输入框，你可以稍后重试。"
      : request.stopReason === "user"
        ? "已停止等待，服务端可能仍在处理。消息已放回输入框。"
        : error.message;
    alert.hidden = false;
  } finally {
    clearTimeout(timer);
    pending = null;
    render();
    input.focus();
  }
});

input.addEventListener("input", () => {
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
$("#menu-toggle").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#sidebar-scrim").hidden = !open;
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
});
$("#sidebar-scrim").addEventListener("click", closeSidebar);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSidebar();
});

newThread();
