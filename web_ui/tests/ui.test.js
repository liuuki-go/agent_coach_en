import assert from "node:assert/strict";
import test from "node:test";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const DATE = "2026-11-05T12:00:00Z";
const REQUEST_KEY_PREFIX = "teresa.chatRequest.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let importNumber = 0;

class Element {
  constructor(name = "div") {
    this.name = name;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.scrollHeight = 100;
    this.namespaceURI = "http://www.w3.org/2000/svg";
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name) => {
        if (classes.has(name)) { classes.delete(name); return false; }
        classes.add(name); return true;
      },
    };
    this._text = "";
  }
  set textContent(text) { this._text = text; this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent ?? child).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  contains(node) { return node === this || this.children.some((child) => child.contains?.(node)); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  async emit(name, event = {}) {
    if (this.disabled && name === "click") return;
    for (const listener of this.listeners.get(name) ?? []) {
      await listener({ preventDefault() {}, ...event });
    }
  }
  focus() {}
}

function session(id, title = id) {
  return { id, title, created_at: DATE, updated_at: DATE };
}

function server(initial = []) {
  const state = {
    sessions: initial,
    details: new Map(initial.map((item) => [item.id, item])),
    histories: new Map(initial.map((item) => [item.id, []])),
    requests: new Map(),
    calls: [],
    onChat: null,
    onHistory: null,
    onModels: null,
    onList: null,
    onSession: null,
    onCreate: null,
    onRequestStatus: null,
    modelCatalog: {
      default: "model-b",
      models: [
        { name: "model-a", display_name: "模型 A" },
        { name: "model-b", display_name: "模型 B" },
      ],
    },
  };
  state.completeChat = (body, reply = "Hello!") => {
    const previous = state.requests.get(body.request_id);
    if (previous?.status !== "succeeded") {
      state.histories.get(body.session_id).push(
        { id: null, role: "user", content: body.content },
        { id: null, role: "assistant", content: reply },
      );
    }
    state.requests.set(body.request_id, {
      request_id: body.request_id, session_id: body.session_id, content: body.content,
      status: "succeeded", reply, error: null,
    });
    return Response.json(reply);
  };
  state.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    state.calls.push({ url, method: options.method, body });
    if (url === "/api/models/getModelList" && options.method === "GET") {
      if (state.onModels) return state.onModels(options);
      return Response.json(state.modelCatalog);
    }
    if (url === "/api/sessions/getAllSessions" && options.method === "GET") {
      if (state.onList) return state.onList(options);
      return Response.json(state.sessions);
    }
    if (url === "/api/sessions/createSession" && options.method === "POST") {
      assert.deepEqual(body, {});
      if (state.onCreate) return state.onCreate(options);
      const next = session([A, B, C].find((id) => !state.details.has(id)), "新的英语时光");
      state.sessions.unshift(next);
      state.details.set(next.id, next);
      state.histories.set(next.id, []);
      return Response.json({ session_id: next });
    }
    if (url === "/api/sessions/getSessionById" && options.method === "POST") {
      if (state.onSession) return state.onSession(body, options);
      const found = state.details.get(body.session_id);
      return found ? Response.json(found) : Response.json({ detail: "会话不存在" }, { status: 404 });
    }
    if (url === "/api/chat" && options.method === "POST") {
      assert.match(body.request_id, UUID_PATTERN);
      if (state.onChat) return state.onChat(body, options);
      const previous = state.requests.get(body.request_id);
      if (previous) {
        if (previous.session_id !== body.session_id || previous.content !== body.content) {
          return Response.json({ detail: "请求 ID 已用于其他会话或内容" }, { status: 409 });
        }
        if (previous.status === "succeeded") return Response.json(previous.reply);
        return Response.json({ detail: previous.error?.message ?? "请求仍在处理中" }, {
          status: previous.status === "processing" ? 409 : 504,
        });
      }
      return state.completeChat(body);
    }
    const parsedUrl = new URL(url, "http://localhost");
    const requestPath = parsedUrl.pathname.match(/^\/api\/chat\/requests\/([^/]+)$/);
    if (requestPath && options.method === "GET") {
      const requestId = requestPath[1];
      const sessionId = parsedUrl.searchParams.get("session_id");
      if (state.onRequestStatus) return state.onRequestStatus(requestId, sessionId, options);
      const found = state.requests.get(requestId);
      if (!found || found.session_id !== sessionId) {
        return Response.json({ detail: "请求不存在" }, { status: 404 });
      }
      return Response.json({
        request_id: found.request_id, session_id: found.session_id, status: found.status,
        reply: found.reply, error: found.error,
      });
    }
    if (url === "/api/sessions/getSessionMessages" && options.method === "POST") {
      if (state.onHistory) return state.onHistory(body, options);
      const found = state.histories.get(body.session_id);
      return found ? Response.json(found) : Response.json({ detail: "会话不存在" }, { status: 404 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  return state;
}

async function openApp(t, state, storage = new Map(), { waitForModels = true, waitForReady = true } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    createElement: (name) => new Element(name),
    createElementNS: (_namespace, name) => new Element(name),
    createTextNode(text) { const node = new Element("text"); node.textContent = text; return node; },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    async emit(name, event) {
      for (const listener of listeners.get(name) ?? []) await listener(event);
    },
  };
  const get = (selector) => document.querySelector(selector);
  get("#model-selector").append(get("#model-menu-toggle"), get("#model-menu"));
  get("#model-menu-toggle").append(get("#model-label"));
  get("#model-menu").append(get("#model-list"));
  get("#model-menu").hidden = true;
  get("#model-status").hidden = true;
  const previous = { document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  Object.assign(globalThis, {
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
      get length() { return storage.size; },
      key: (index) => [...storage.keys()][index] ?? null,
    },
    fetch: state.fetch,
  });
  t.after(() => Object.assign(globalThis, previous));
  const app = await import(`../app.js?ui-test=${++importNumber}`);
  if (waitForReady) await app.ready;
  if (waitForModels) await app.modelsReady;
  return { get, storage, document, ready: app.ready, modelsReady: app.modelsReady };
}

function threadButton(ui, title) {
  return ui.get("#thread-list").children.find((button) => button.textContent === title);
}

function chatCalls(state) {
  return state.calls.filter((call) => call.url === "/api/chat");
}

function statusCalls(state) {
  return state.calls.filter((call) => call.url.startsWith("/api/chat/requests/"));
}

function assertChatBody(body, sessionId, content) {
  assert.match(body.request_id, UUID_PATTERN);
  assert.deepEqual(body, { session_id: sessionId, content, request_id: body.request_id });
  return body.request_id;
}

function storedRequests(storage) {
  return [...storage].filter(([key]) => key.startsWith(REQUEST_KEY_PREFIX))
    .map(([, value]) => JSON.parse(value));
}

function seedRequest(storage, requestId, sessionId, content, status = "pending", extra = {}) {
  const record = { requestId, sessionId, content, status, createdAt: new Date(DATE).toISOString(), ...extra };
  storage.set(`${REQUEST_KEY_PREFIX}${requestId}`, JSON.stringify(record));
  return record;
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function deadlineClock(t) {
  const previous = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map();
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 10000 && delay !== 120000) return previous.setTimeout(callback, delay, ...args);
    const handle = {};
    timers.set(handle, { callback, delay, args });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (!timers.delete(handle)) previous.clearTimeout(handle);
  };
  t.after(() => {
    timers.clear();
    Object.assign(globalThis, previous);
  });
  return {
    expire(delay) {
      const due = [...timers].filter(([, timer]) => timer.delay === delay);
      assert.equal(due.length, 1, `应恰有一个等待中的 ${delay}ms 请求`);
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.callback(...timer.args);
      }
    },
  };
}

function waitForAbort(options) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  });
}

function stalledRequest() {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  return {
    started,
    handle(options) {
      markStarted();
      return waitForAbort(options);
    },
  };
}

function assertReady(ui) {
  assert.equal(ui.get("#message-input").disabled, false);
  assert.equal(ui.get("#new-chat").disabled, false);
  assert.equal(ui.get("#reload-history").disabled, false);
  assert.equal(ui.get("#stop-button").hidden, true);
  assert.equal(ui.get("#message-list").attributes.get("aria-busy"), "false");
}

function assertRecoverySettled(ui) {
  assert.equal(ui.get("#request-recovery").hidden, false);
  assert.equal(ui.get("#new-chat").disabled, false);
  assert.equal(ui.get("#reload-history").disabled, false);
  assert.equal(ui.get("#stop-button").hidden, true);
  assert.equal(ui.get("#message-list").attributes.get("aria-busy"), "false");
}

test("模型菜单展示服务端默认项和全部安全文字，其他项不可切换且聊天请求不变", async (t) => {
  const state = server([session(A, "英语练习")]);
  state.modelCatalog.models[0].display_name = "<img src=x onerror=alert(1)>";
  const ui = await openApp(t, state);
  assert.equal(ui.get("#model-label").textContent, "模型 B");
  assert.equal(ui.get("#model-menu-toggle").disabled, false);
  assert.equal(ui.get("#model-menu").hidden, true);
  await ui.get("#model-menu-toggle").emit("click");
  assert.equal(ui.get("#model-menu").hidden, false);
  assert.equal(ui.get("#model-menu-toggle").attributes.get("aria-expanded"), "true");
  const items = ui.get("#model-list").children;
  assert.equal(items.length, 2);
  assert.equal(items[0].attributes.has("aria-current"), false);
  assert.equal(items[1].attributes.get("aria-current"), "true");
  assert.match(items[0].textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(descendants(ui.get("#model-list")).some((node) => node.name === "img"), false);
  const beforeClick = state.calls.length;
  await items[0].emit("click");
  assert.equal(state.calls.length, beforeClick);
  assert.equal(ui.get("#model-label").textContent, "模型 B");
  assert.equal(items[1].attributes.get("aria-current"), "true");
  assert.deepEqual([...ui.storage.entries()], [["teresa.activeSessionId", A]]);
  ui.get("#message-input").value = "正常聊天";
  await ui.get("#chat-form").emit("submit");
  assertChatBody(chatCalls(state)[0].body, A, "正常聊天");
  assert.deepEqual(state.calls.filter((call) => call.url.startsWith("/api/models/")), [
    { url: "/api/models/getModelList", method: "GET", body: undefined },
  ]);
});

test("模型菜单支持Escape与外部点击关闭，内部点击保持展开", async (t) => {
  const ui = await openApp(t, server([session(A, "英语练习")]));
  await ui.get("#model-menu-toggle").emit("click");
  await ui.document.emit("pointerdown", { target: ui.get("#model-list").children[0] });
  assert.equal(ui.get("#model-menu").hidden, false);
  await ui.document.emit("keydown", { key: "Escape" });
  assert.equal(ui.get("#model-menu").hidden, true);
  assert.equal(ui.get("#model-menu-toggle").attributes.get("aria-expanded"), "false");
  await ui.get("#model-menu-toggle").emit("click");
  await ui.document.emit("pointerdown", { target: ui.get("#message-input") });
  assert.equal(ui.get("#model-menu").hidden, true);
  assert.equal(ui.get("#model-menu-toggle").attributes.get("aria-expanded"), "false");
});

test("模型列表读取失败独立提示，不阻塞历史显示和正常聊天", async (t) => {
  const state = server([session(A, "英语练习")]);
  state.histories.set(A, [{ role: "assistant", content: "服务端历史仍可读取" }]);
  state.onModels = () => Response.json({ detail: "模型配置暂不可用" }, { status: 503 });
  const ui = await openApp(t, state);
  assert.equal(ui.get("#model-label").textContent, "模型列表不可用");
  assert.equal(ui.get("#model-menu-toggle").disabled, true);
  assert.equal(ui.get("#model-status").hidden, false);
  assert.match(ui.get("#model-status").textContent, /模型列表读取失败/);
  assert.match(ui.get("#message-list").textContent, /服务端历史仍可读取/);
  assert.equal(ui.get("#chat-error").hidden, true);
  assert.equal(ui.get("#message-input").disabled, false);
  ui.get("#message-input").value = "模型列表失败时继续聊天";
  await ui.get("#chat-form").emit("submit");
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  assertChatBody(chatCalls(state)[0].body, A, "模型列表失败时继续聊天");
  assert.equal(ui.get("#model-status").hidden, false);
});

test("模型元数据独立异步读取，尚未完成时不显示假默认且会话已可使用", async (t) => {
  const state = server([session(A, "英语练习")]);
  let finishModels;
  state.onModels = () => new Promise((resolve) => { finishModels = resolve; });
  const ui = await openApp(t, state, new Map(), { waitForModels: false });
  assert.equal(ui.get("#model-label").textContent, "正在读取模型…");
  assert.equal(ui.get("#model-menu-toggle").disabled, true);
  assert.equal(ui.get("#message-input").disabled, false);
  ui.get("#message-input").value = "无需等待模型列表";
  await ui.get("#chat-form").emit("submit");
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  finishModels(Response.json(state.modelCatalog));
  await ui.modelsReady;
  assert.equal(ui.get("#model-label").textContent, "模型 B");
  assert.equal(ui.get("#model-menu-toggle").disabled, false);
});

test("重新打开页面以服务端默认模型为准，不持久化本地模型选项", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map();
  const ui = await openApp(t, state, storage);
  assert.equal(ui.get("#model-label").textContent, "模型 B");
  state.modelCatalog.default = "model-a";
  await t.test("服务端默认值改变后重新加载", async (child) => {
    const reopened = await openApp(child, state, storage);
    assert.equal(reopened.get("#model-label").textContent, "模型 A");
    assert.equal(reopened.get("#model-list").children[0].attributes.get("aria-current"), "true");
    assert.equal(reopened.get("#model-list").children[1].attributes.has("aria-current"), false);
    assert.deepEqual([...storage.entries()], [["teresa.activeSessionId", A]]);
    assert.equal(state.calls.filter((call) => call.url === "/api/models/getModelList").length, 2);
  });
});

test("启动读取已选会话历史，切换会话读取对应消息而不混入", async (t) => {
  const state = server([session(A, "日常英语"), session(B, "面试练习")]);
  state.histories.set(A, [{ id: "a-1", role: "user", content: "A的历史" }]);
  state.histories.set(B, [{ id: "b-1", role: "assistant", content: "B的历史" }]);
  const ui = await openApp(t, state, new Map([["teresa.activeSessionId", B]]));
  assert.equal(threadButton(ui, "面试练习").attributes.get("aria-current"), "page");
  assert.equal(ui.get("#message-list").children.length, 1);
  assert.match(ui.get("#message-list").textContent, /B的历史/);
  assert.doesNotMatch(ui.get("#message-list").textContent, /A的历史/);
  assert.match(ui.get("#history-note").textContent, /重新读取已保存的消息/);
  await threadButton(ui, "日常英语").emit("click");
  assert.equal(ui.storage.get("teresa.activeSessionId"), A);
  assert.deepEqual(state.calls.at(-1), {
    url: "/api/sessions/getSessionMessages", method: "POST", body: { session_id: A },
  });
  assert.match(ui.get("#message-list").textContent, /A的历史/);
  assert.doesNotMatch(ui.get("#message-list").textContent, /B的历史/);
  assert.equal(chatCalls(state).length, 0);
});

test("浏览器没有保存会话ID时加载服务端已有会话和历史，不创建新会话", async (t) => {
  const state = server([session(B, "已有会话")]);
  state.histories.set(B, [
    { id: "saved-user", role: "user", content: "数据库中已有的问题" },
    { id: "saved-answer", role: "assistant", content: "数据库中已有的回复" },
  ]);
  const storage = new Map();
  const ui = await openApp(t, state, storage);

  assert.equal(threadButton(ui, "已有会话").attributes.get("aria-current"), "page");
  assert.equal(storage.get("teresa.activeSessionId"), B);
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.match(ui.get("#message-list").textContent, /数据库中已有的问题/);
  assert.match(ui.get("#message-list").textContent, /数据库中已有的回复/);
  assert.equal(ui.get("#chat-error").hidden, true);
  assert.deepEqual(state.calls.filter((call) => call.url === "/api/sessions/getSessionMessages"), [
    { url: "/api/sessions/getSessionMessages", method: "POST", body: { session_id: B } },
  ]);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 0);
  assert.equal(chatCalls(state).length, 0);
});

test("保存的会话ID已失效时回退到服务端有效会话并读取历史，不创建新会话", async (t) => {
  const state = server([session(B, "有效会话")]);
  state.histories.set(B, [{ id: "saved-answer", role: "assistant", content: "有效会话的历史" }]);
  const storage = new Map([["teresa.activeSessionId", C]]);
  const ui = await openApp(t, state, storage);

  assert.equal(threadButton(ui, "有效会话").attributes.get("aria-current"), "page");
  assert.equal(storage.get("teresa.activeSessionId"), B);
  assert.equal(ui.get("#message-list").children.length, 1);
  assert.match(ui.get("#message-list").textContent, /有效会话的历史/);
  assert.equal(ui.get("#chat-error").hidden, true);
  assert.deepEqual(state.calls.filter((call) => call.url === "/api/sessions/getSessionById"), [
    { url: "/api/sessions/getSessionById", method: "POST", body: { session_id: B } },
  ]);
  assert.deepEqual(state.calls.filter((call) => call.url === "/api/sessions/getSessionMessages"), [
    { url: "/api/sessions/getSessionMessages", method: "POST", body: { session_id: B } },
  ]);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 0);
  assert.equal(chatCalls(state).length, 0);
});

test("新建使用后端会话ID，聊天只发送本次内容和请求ID，本页切换保留真实回复", async (t) => {
  const state = server([session(A, "旧会话")]);
  const ui = await openApp(t, state);
  await ui.get("#new-chat").emit("click");
  assert.equal(ui.storage.get("teresa.activeSessionId"), B);
  assert.equal(ui.get("#message-list").children.length, 0);
  ui.get("#message-input").value = "本次新问题";
  await ui.get("#chat-form").emit("submit");
  assertChatBody(chatCalls(state)[0].body, B, "本次新问题");
  assert.match(ui.get("#message-list").textContent, /本次新问题/);
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.equal(ui.get("#message-input").value, "");
  assert.ok(threadButton(ui, "新的英语时光"));
  assert.equal(state.details.get(B).title, "新的英语时光");
  await threadButton(ui, "旧会话").emit("click");
  assert.equal(ui.get("#message-list").children.length, 0);
  await threadButton(ui, "新的英语时光").emit("click");
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  assert.equal(chatCalls(state).length, 1);
});

test("刷新列表重新读取服务端历史，不重复拼接消息并保留未发送草稿", async (t) => {
  const state = server([session(A, "英语练习")]);
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "已发送的内容";
  await ui.get("#chat-form").emit("submit");
  ui.get("#message-input").value = "还没发送的草稿";
  await ui.get("#message-input").emit("input");
  state.details.get(A).title = "后端更新的标题";
  state.histories.get(A).push({ id: "remote", role: "assistant", content: "其他页面保存的回复" });
  await ui.get("#reload-history").emit("click");
  assert.ok(threadButton(ui, "后端更新的标题"));
  assert.equal(ui.get("#message-input").value, "还没发送的草稿");
  assert.equal(ui.get("#message-list").children.length, 3);
  assert.match(ui.get("#message-list").textContent, /其他页面保存的回复/);
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.get("#message-list").children.length, 3);
  assert.equal(chatCalls(state).length, 1);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 0);
});

test("重新打开页面用会话ID读取服务端聊天，不依赖浏览器存储消息", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map();
  const ui = await openApp(t, state, storage);
  ui.get("#message-input").value = "已保存的问题";
  await ui.get("#chat-form").emit("submit");
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.deepEqual([...storage.entries()], [["teresa.activeSessionId", A]]);
  await t.test("模拟重新打开", async (child) => {
    const reopened = await openApp(child, state, storage);
    assert.equal(reopened.storage.get("teresa.activeSessionId"), A);
    assert.equal(reopened.get("#message-list").children.length, 2);
    assert.match(reopened.get("#message-list").textContent, /已保存的问题/);
    assert.match(reopened.get("#message-list").textContent, /Hello!/);
    assert.equal(chatCalls(state).length, 1);
  });
});

test("首次没有会话时创建一段，刷新列表不重复创建", async (t) => {
  const state = server();
  const ui = await openApp(t, state);
  assert.equal(ui.get("#thread-count").textContent, "01");
  await ui.get("#reload-history").emit("click");
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 1);
  assert.equal(ui.storage.get("teresa.activeSessionId"), A);
});

test("有效空历史显示欢迎页，历史没有时间时不伪造时间", async (t) => {
  const state = server([session(A, "空会话")]);
  const ui = await openApp(t, state);
  assert.equal(ui.get("#chat-error").hidden, true);
  assert.equal(ui.get("#welcome").hidden, false);
  assert.equal(ui.get("#message-list").children.length, 0);
  state.histories.set(A, [
    { id: null, role: "user", content: "只有用户输入的未完成会话" },
  ]);
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.get("#message-list").children.length, 1);
  assert.equal(descendants(ui.get("#message-list")).some((node) => node.name === "time"), false);
  assert.equal(ui.get("#welcome").hidden, true);
  state.histories.set(A, []);
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.get("#message-list").children.length, 0);
  assert.equal(ui.get("#welcome").hidden, false);
  assert.equal(ui.get("#chat-error").hidden, true);
});

test("切换时历史读取失败保留原会话消息和草稿，重试成功后显示目标历史", async (t) => {
  const state = server([session(A, "A会话"), session(B, "B会话")]);
  state.histories.set(A, [{ id: "a", role: "user", content: "A历史" }]);
  state.histories.set(B, [{ id: "b", role: "user", content: "B历史" }]);
  const ui = await openApp(t, state, new Map([["teresa.activeSessionId", A]]));
  ui.get("#message-input").value = "A草稿";
  state.onHistory = () => Response.json({ detail: "历史读取失败" }, { status: 503 });
  await threadButton(ui, "B会话").emit("click");
  assert.match(ui.get("#chat-error").textContent, /历史读取失败/);
  assert.match(ui.get("#message-list").textContent, /A历史/);
  assert.doesNotMatch(ui.get("#message-list").textContent, /B历史/);
  assert.equal(ui.get("#message-input").value, "A草稿");
  assert.equal(ui.storage.get("teresa.activeSessionId"), A);
  state.onHistory = null;
  await threadButton(ui, "B会话").emit("click");
  assert.match(ui.get("#message-list").textContent, /B历史/);
  assert.equal(ui.get("#message-input").value, "");
  ui.get("#message-input").value = "B草稿";
  await threadButton(ui, "A会话").emit("click");
  assert.equal(ui.get("#message-input").value, "A草稿");
  await threadButton(ui, "B会话").emit("click");
  assert.equal(ui.get("#message-input").value, "B草稿");
});

test("历史读取失败不清空已显示消息，首次失败也不冒充空会话", async (t) => {
  const state = server([session(A, "历史会话")]);
  state.histories.set(A, [{ role: "assistant", content: "已有回复" }]);
  const ui = await openApp(t, state);
  state.onHistory = () => Response.json({ messages: [] });
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.get("#message-list").children.length, 1);
  assert.match(ui.get("#message-list").textContent, /已有回复/);
  assert.equal(ui.get("#chat-error").hidden, false);
  assert.equal(chatCalls(state).length, 0);
  await t.test("重新打开时失败", async (child) => {
    const reopened = await openApp(child, state);
    assert.equal(reopened.get("#chat-error").hidden, false);
    assert.equal(reopened.get("#message-input").disabled, true);
    assert.equal(chatCalls(state).length, 0);
  });
});

test("回复成功立即显示，同步历史后替换本轮消息而不重复", async (t) => {
  const state = server([session(A, "英语练习")]);
  const ui = await openApp(t, state);
  let started;
  let release;
  const syncing = new Promise((resolve) => { started = resolve; });
  state.onHistory = () => {
    started();
    return new Promise((resolve) => { release = resolve; });
  };
  ui.get("#message-input").value = "立即显示";
  const submitting = ui.get("#chat-form").emit("submit");
  await syncing;
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  assert.equal(ui.get("#message-input").disabled, true);
  release(Response.json(state.histories.get(A)));
  await submitting;
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.equal(ui.get("#chat-error").hidden, true);
  assert.equal(descendants(ui.get("#message-list")).some((node) => node.name === "time"), false);
  assert.equal(chatCalls(state).length, 1);
});

test("已收到回复后历史同步失败仍保留回复，不放回草稿或重复发送", async (t) => {
  const state = server([session(A, "英语练习")]);
  const ui = await openApp(t, state);
  state.onHistory = () => Response.json({ detail: "临时失败" }, { status: 503 });
  ui.get("#message-input").value = "成功的问题";
  await ui.get("#chat-form").emit("submit");
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  assert.match(ui.get("#chat-error").textContent, /回复已收到，但历史同步失败/);
  assert.equal(ui.get("#message-input").value, "");
  assert.equal(chatCalls(state).length, 1);
  state.onHistory = null;
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.equal(ui.get("#chat-error").hidden, true);
});

test("服务端历史尚未包含已收到回复时保留当前回复并提示确认", async (t) => {
  const state = server([session(A, "英语练习")]);
  const ui = await openApp(t, state);
  state.onHistory = () => Response.json([]);
  ui.get("#message-input").value = "保存检查";
  await ui.get("#chat-form").emit("submit");
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.match(ui.get("#chat-error").textContent, /暂未包含本轮回复/);
  assert.equal(chatCalls(state).length, 1);
});

test("历史中的HTML也只作为文本显示", async (t) => {
  const state = server([session(A, "历史会话")]);
  state.histories.set(A, [{ role: "assistant", content: "<img src=x onerror=alert(1)>" }]);
  const ui = await openApp(t, state);
  assert.match(ui.get("#message-list").textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(descendants(ui.get("#message-list")).some((node) => node.name === "img" && node.src === "x"), false);
  assert.equal(chatCalls(state).length, 0);
});

test("停止只取消等待，保留原请求且不自动发送，显式重试复用同一ID", async (t) => {
  const state = server([session(A, "英语练习")]);
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  state.onChat = (_body, options) => {
    signalStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "稍后回复的问题";
  const submitting = ui.get("#chat-form").emit("submit");
  await started;
  await ui.get("#stop-button").emit("click");
  await submitting;
  const requestId = assertChatBody(chatCalls(state)[0].body, A, "稍后回复的问题");
  assert.equal(storedRequests(ui.storage)[0].requestId, requestId);
  assert.equal(storedRequests(ui.storage)[0].content, "稍后回复的问题");
  assertRecoverySettled(ui);
  assert.equal(ui.get("#message-list").children.length, 0);
  assert.equal(chatCalls(state).length, 1);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/getSessionById").length, 1);
  state.onChat = null;
  await ui.get("#check-request").emit("click");
  await ui.get("#retry-request").emit("click");
  assert.equal(chatCalls(state).length, 2);
  assert.deepEqual(chatCalls(state)[1].body, chatCalls(state)[0].body);
  assert.equal(ui.get("#message-list").children.length, 2);
});

test("超时停止等待保留原ID和正文，不能把超时当服务端取消", async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 120000 ? 0 : delay, ...args);
  t.after(() => { globalThis.setTimeout = realSetTimeout; });
  const state = server([session(A, "英语练习")]);
  state.onChat = (_body, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "超时的问题";
  await ui.get("#chat-form").emit("submit");
  assert.equal(storedRequests(ui.storage)[0].content, "超时的问题");
  assert.equal(storedRequests(ui.storage)[0].requestId, chatCalls(state)[0].body.request_id);
  assert.match(ui.get("#chat-error").textContent, /等待超过两分钟/);
  assert.equal(chatCalls(state).length, 1);
  assertRecoverySettled(ui);
});

test("响应丢失保留原请求，查询404后显式同ID重试，不伪造消息", async (t) => {
  const state = server([session(A, "英语练习")]);
  let attempts = 0;
  state.onChat = (body) => {
    if (++attempts === 1) throw new TypeError("response lost after processing");
    return state.completeChat(body, "真实收到的回复");
  };
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "网络测试";
  await ui.get("#chat-form").emit("submit");
  assert.equal(storedRequests(ui.storage)[0].content, "网络测试");
  assert.equal(storedRequests(ui.storage)[0].requestId, chatCalls(state)[0].body.request_id);
  assert.equal(ui.get("#message-list").children.length, 0);
  assert.equal(chatCalls(state).length, 1);
  await ui.get("#check-request").emit("click");
  await ui.get("#retry-request").emit("click");
  assert.equal(chatCalls(state).length, 2);
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.deepEqual(chatCalls(state)[1].body, chatCalls(state)[0].body);
  assert.match(ui.get("#message-list").textContent, /真实收到的回复/);
});

test("不存在的会话显示后端错误，不把404当成空历史", async (t) => {
  const state = server([session(A, "已删除的会话")]);
  state.details.clear();
  const ui = await openApp(t, state);
  assert.equal(ui.get("#chat-error").hidden, false);
  assert.match(ui.get("#chat-error").textContent, /会话不存在/);
  assert.equal(ui.get("#message-input").disabled, true);
  assert.equal(ui.get("#message-list").children.length, 0);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 0);
});

test("模型HTML只作为文本显示，reply不会成为可执行DOM", async (t) => {
  const state = server([session(A, "英语练习")]);
  state.onChat = () => Response.json("<img src=x onerror=alert(1)>");
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "安全显示";
  await ui.get("#chat-form").emit("submit");
  assert.match(ui.get("#message-list").textContent, /<img src=x onerror=alert\(1\)>/);
  const nodes = [];
  const visit = (node) => { nodes.push(node); node.children?.forEach(visit); };
  visit(ui.get("#message-list"));
  assert.equal(nodes.some((node) => node.name === "img" && node.src === "x"), false);
});

test("首次会话列表超时后可以刷新，不把未知结果当空列表创建会话", async (t) => {
  const clock = deadlineClock(t);
  const state = server([session(A, "已有会话")]);
  const stalled = stalledRequest();
  state.onList = stalled.handle;
  const ui = await openApp(t, state, new Map(), { waitForReady: false });
  await stalled.started;
  assert.equal(ui.get("#reload-history").disabled, true);
  clock.expire(10000);
  await ui.ready;
  assert.match(ui.get("#chat-error").textContent, /超时/);
  assert.equal(ui.get("#reload-history").disabled, false);
  assert.equal(ui.get("#new-chat").disabled, false);
  assert.equal(ui.get("#message-input").disabled, true);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 0);
  state.onList = null;
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.storage.get("teresa.activeSessionId"), A);
  assertReady(ui);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 0);
});

for (const phase of ["metadata", "history"]) {
  test(`切换会话${phase === "metadata" ? "元数据" : "历史"}超时后保留原会话和草稿`, async (t) => {
    const clock = deadlineClock(t);
    const state = server([session(A, "A会话"), session(B, "B会话")]);
    state.histories.set(A, [{ role: "assistant", content: "A原有历史" }]);
    state.histories.set(B, [{ role: "assistant", content: "B目标历史" }]);
    const ui = await openApp(t, state, new Map([["teresa.activeSessionId", A]]));
    ui.get("#message-input").value = "A未发送的草稿";
    const stalled = stalledRequest();
    if (phase === "metadata") state.onSession = (_body, options) => stalled.handle(options);
    else state.onHistory = (_body, options) => stalled.handle(options);
    const selecting = threadButton(ui, "B会话").emit("click");
    await stalled.started;
    assert.equal(ui.get("#message-input").disabled, true);
    clock.expire(10000);
    await selecting;
    assert.equal(ui.storage.get("teresa.activeSessionId"), A);
    assert.equal(ui.get("#message-input").value, "A未发送的草稿");
    assert.match(ui.get("#message-list").textContent, /A原有历史/);
    assert.doesNotMatch(ui.get("#message-list").textContent, /B目标历史/);
    assert.match(ui.get("#chat-error").textContent, /超时/);
    assertReady(ui);
    state.onSession = null;
    state.onHistory = null;
    await threadButton(ui, "B会话").emit("click");
    assert.match(ui.get("#message-list").textContent, /B目标历史/);
    await threadButton(ui, "A会话").emit("click");
    assert.equal(ui.get("#message-input").value, "A未发送的草稿");
    assert.equal(chatCalls(state).length, 0);
  });
}

test("刷新历史超时后保留已有历史和草稿并允许再次刷新", async (t) => {
  const clock = deadlineClock(t);
  const state = server([session(A, "英语练习")]);
  state.histories.set(A, [{ role: "assistant", content: "已保存的回复" }]);
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "不应丢失的草稿";
  const stalled = stalledRequest();
  state.onHistory = (_body, options) => stalled.handle(options);
  const refreshing = ui.get("#reload-history").emit("click");
  await stalled.started;
  clock.expire(10000);
  await refreshing;
  assert.match(ui.get("#message-list").textContent, /已保存的回复/);
  assert.equal(ui.get("#message-list").children.length, 1);
  assert.equal(ui.get("#message-input").value, "不应丢失的草稿");
  assert.match(ui.get("#chat-error").textContent, /超时/);
  assertReady(ui);
  state.onHistory = null;
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.get("#message-list").children.length, 1);
  assert.equal(ui.get("#message-input").value, "不应丢失的草稿");
  assert.equal(chatCalls(state).length, 0);
});

test("成功回复后的历史同步超时保留回复并解除忙碌，不恢复草稿或重发聊天", async (t) => {
  const clock = deadlineClock(t);
  const state = server([session(A, "英语练习")]);
  const ui = await openApp(t, state);
  const stalled = stalledRequest();
  state.onHistory = (_body, options) => stalled.handle(options);
  ui.get("#message-input").value = "已经成功的问题";
  const submitting = ui.get("#chat-form").emit("submit");
  await stalled.started;
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  assert.equal(ui.get("#message-input").disabled, true);
  assert.equal(ui.get("#stop-button").hidden, true);
  clock.expire(10000);
  await submitting;
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.match(ui.get("#message-list").textContent, /已经成功的问题/);
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  assert.match(ui.get("#chat-error").textContent, /回复已收到，但历史同步失败/);
  assert.match(ui.get("#chat-error").textContent, /超时/);
  assert.equal(ui.get("#message-input").value, "");
  assert.equal(chatCalls(state).length, 1);
  assertRecoverySettled(ui);
  state.onHistory = null;
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.equal(chatCalls(state).length, 1);
});

test("新建会话超时保留原会话和草稿，刷新可以确认后台已创建的会话", async (t) => {
  const clock = deadlineClock(t);
  const state = server([session(A, "原会话")]);
  state.histories.set(A, [{ role: "assistant", content: "原会话历史" }]);
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "原会话草稿";
  const stalled = stalledRequest();
  state.onCreate = (options) => {
    const created = session(B, "后台已创建的会话");
    state.sessions.unshift(created);
    state.details.set(B, created);
    state.histories.set(B, []);
    return stalled.handle(options);
  };
  const creating = ui.get("#new-chat").emit("click");
  await stalled.started;
  clock.expire(10000);
  await creating;
  assert.equal(ui.storage.get("teresa.activeSessionId"), A);
  assert.equal(ui.get("#message-input").value, "原会话草稿");
  assert.match(ui.get("#message-list").textContent, /原会话历史/);
  assert.match(ui.get("#chat-error").textContent, /可能.*创建/);
  assert.match(ui.get("#chat-error").textContent, /刷新.*确认/);
  assertReady(ui);
  state.onCreate = null;
  await ui.get("#reload-history").emit("click");
  assert.ok(threadButton(ui, "后台已创建的会话"));
  assert.equal(ui.storage.get("teresa.activeSessionId"), A);
  assert.equal(ui.get("#message-input").value, "原会话草稿");
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 1);
});

test("首次自动创建超时后刷新空列表不再次自动创建，后台会话出现后可以恢复", async (t) => {
  const clock = deadlineClock(t);
  const state = server();
  const stalled = stalledRequest();
  state.onCreate = stalled.handle;
  const ui = await openApp(t, state, new Map(), { waitForReady: false });
  await stalled.started;
  clock.expire(10000);
  await ui.ready;
  assert.match(ui.get("#chat-error").textContent, /可能.*创建/);
  assert.equal(ui.get("#reload-history").disabled, false);
  assert.equal(ui.get("#message-input").disabled, true);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 1);
  state.onCreate = null;
  await ui.get("#reload-history").emit("click");
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 1);
  assert.equal(ui.get("#message-input").disabled, true);
  assert.match(ui.get("#chat-error").textContent, /创建|确认/);
  const created = session(A, "后台确认的会话");
  state.sessions.push(created);
  state.details.set(A, created);
  state.histories.set(A, []);
  await ui.get("#reload-history").emit("click");
  assert.equal(ui.storage.get("teresa.activeSessionId"), A);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/createSession").length, 1);
  assertReady(ui);
});

test("模型列表超时独立提示，等待期间和超时后均可继续聊天", async (t) => {
  const clock = deadlineClock(t);
  const state = server([session(A, "英语练习")]);
  const stalled = stalledRequest();
  state.onModels = stalled.handle;
  const ui = await openApp(t, state, new Map(), { waitForModels: false });
  await stalled.started;
  assert.equal(ui.get("#model-label").textContent, "正在读取模型…");
  assertReady(ui);
  ui.get("#message-input").value = "模型列表等待期间的问题";
  await ui.get("#chat-form").emit("submit");
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  clock.expire(10000);
  await ui.modelsReady;
  assert.equal(ui.get("#model-label").textContent, "模型列表不可用");
  assert.equal(ui.get("#model-menu-toggle").disabled, true);
  assert.match(ui.get("#model-status").textContent, /超时/);
  assert.equal(ui.get("#chat-error").hidden, true);
  assertReady(ui);
  ui.get("#message-input").value = "模型列表超时后的问题";
  await ui.get("#chat-form").emit("submit");
  assert.equal(chatCalls(state).length, 2);
  assert.equal(ui.get("#message-list").children.length, 4);
  assert.equal(ui.get("#model-status").hidden, false);
});

test("聊天响应头到达后body挂起仍保留原请求，不能误报无效JSON", async (t) => {
  const clock = deadlineClock(t);
  const state = server([session(A, "英语练习")]);
  const stalled = stalledRequest();
  state.onChat = (_body, options) => ({
    ok: true,
    status: 200,
    json: () => stalled.handle(options),
  });
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "body未完成的问题";
  const submitting = ui.get("#chat-form").emit("submit");
  await stalled.started;
  assert.equal(ui.get("#stop-button").hidden, false);
  clock.expire(120000);
  await submitting;
  assert.equal(storedRequests(ui.storage)[0].content, "body未完成的问题");
  assert.equal(storedRequests(ui.storage)[0].requestId, chatCalls(state)[0].body.request_id);
  assert.equal(ui.get("#message-list").children.length, 0);
  assert.match(ui.get("#chat-error").textContent, /等待超过两分钟/);
  assert.doesNotMatch(ui.get("#chat-error").textContent, /无效.*JSON/);
  assert.equal(chatCalls(state).length, 1);
  assertRecoverySettled(ui);
});

test("每次新逻辑发送先持久化独立UUID，相同正文的新消息使用不同ID", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map();
  state.onChat = (body) => {
    const record = storedRequests(storage).find((item) => item.requestId === body.request_id);
    assert.ok(record, "请求必须在POST前成功保存");
    assert.equal(record.sessionId, body.session_id);
    assert.equal(record.content, body.content);
    return state.completeChat(body);
  };
  const ui = await openApp(t, state, storage);
  for (let index = 0; index < 2; index++) {
    ui.get("#message-input").value = "  same words  ";
    await ui.get("#chat-form").emit("submit");
    assertReady(ui);
    assert.equal(storedRequests(storage).length, 0);
  }
  const calls = chatCalls(state);
  assert.equal(calls.length, 2);
  assertChatBody(calls[0].body, A, "same words");
  assertChatBody(calls[1].body, A, "same words");
  assert.notEqual(calls[0].body.request_id, calls[1].body.request_id);
  assert.equal(ui.get("#message-list").children.length, 4);
});

test("存在未知请求时修改正文不能覆盖旧ID，显式重试仍发送原文", async (t) => {
  const state = server([session(A, "英语练习")]);
  state.onChat = () => { throw new TypeError("response lost"); };
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "最初的问题";
  await ui.get("#chat-form").emit("submit");
  const original = { ...chatCalls(state)[0].body };
  ui.get("#message-input").value = "这是另一条新消息";
  await ui.get("#message-input").emit("input");
  await ui.get("#chat-form").emit("submit");
  assert.equal(chatCalls(state).length, 1);
  assert.equal(storedRequests(ui.storage).length, 1);
  assert.equal(storedRequests(ui.storage)[0].requestId, original.request_id);
  assert.equal(storedRequests(ui.storage)[0].content, "最初的问题");
  state.onChat = null;
  await ui.get("#check-request").emit("click");
  await ui.get("#retry-request").emit("click");
  assert.equal(chatCalls(state).length, 2);
  assert.deepEqual(chatCalls(state)[1].body, original);
  assert.match(ui.get("#message-list").textContent, /最初的问题/);
  assert.doesNotMatch(ui.get("#message-list").textContent, /这是另一条新消息/);
});

test("回复已保存但响应丢失，重新打开仅GET恢复且不重复显示历史", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map();
  state.onChat = (body) => {
    state.completeChat(body, "后台已完成的回复");
    throw new TypeError("response lost after success");
  };
  const ui = await openApp(t, state, storage);
  ui.get("#message-input").value = "后端已保存的问题";
  await ui.get("#chat-form").emit("submit");
  const requestId = chatCalls(state)[0].body.request_id;
  assert.equal(storedRequests(storage)[0].requestId, requestId);
  state.onChat = null;
  await t.test("重新打开恢复结果", async (child) => {
    const reopened = await openApp(child, state, storage);
    assert.equal(chatCalls(state).length, 1);
    assert.equal(statusCalls(state).length, 1);
    const query = new URL(statusCalls(state)[0].url, "http://localhost");
    assert.equal(query.pathname, `/api/chat/requests/${requestId}`);
    assert.equal(query.searchParams.get("session_id"), A);
    assert.equal(reopened.get("#message-list").children.length, 2);
    assert.match(reopened.get("#message-list").textContent, /后台已完成的回复/);
    assert.equal(storedRequests(storage).length, 0);
    assertReady(reopened);
  });
});

test("恢复processing仅查询不自动POST，完成后再次查询替换历史", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  seedRequest(storage, C, A, "仍在处理的问题");
  const body = { request_id: C, session_id: A, content: "仍在处理的问题" };
  state.requests.set(C, { ...body, status: "processing", reply: null, error: null });
  const ui = await openApp(t, state, storage);
  assert.equal(chatCalls(state).length, 0);
  assert.equal(statusCalls(state).length, 1);
  assert.equal(storedRequests(storage)[0].requestId, C);
  assert.match(ui.get("#request-note").textContent, /处理|尚未完成/);
  ui.get("#message-input").value = "不能绕过旧请求的新问题";
  await ui.get("#chat-form").emit("submit");
  assert.equal(chatCalls(state).length, 0);
  state.completeChat(body, "处理完成的回复");
  await ui.get("#check-request").emit("click");
  assert.equal(chatCalls(state).length, 0);
  assert.equal(ui.get("#message-list").children.length, 2);
  assert.match(ui.get("#message-list").textContent, /处理完成的回复/);
  assert.equal(storedRequests(storage).length, 0);
});

test("恢复failed展示原错误且不重跑，明确开始新消息才生成新ID", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  seedRequest(storage, C, A, "失败的旧问题");
  state.requests.set(C, {
    request_id: C, session_id: A, content: "失败的旧问题", status: "failed", reply: null,
    error: { code: "MODEL_TIMEOUT", message: "模型原有超时错误" },
  });
  const ui = await openApp(t, state, storage);
  assert.equal(storedRequests(storage)[0].status, "failed");
  assert.match(ui.get("#request-note").textContent + ui.get("#request-result").textContent, /模型原有超时错误/);
  assert.equal(chatCalls(state).length, 0);
  await ui.get("#retry-request").emit("click");
  assert.equal(chatCalls(state).length, 0);
  await ui.get("#new-request").emit("click");
  assert.equal(storedRequests(storage).length, 0);
  ui.get("#message-input").value = "失败的旧问题";
  await ui.get("#chat-form").emit("submit");
  assert.equal(chatCalls(state).length, 1);
  assert.notEqual(chatCalls(state)[0].body.request_id, C);
});

test("恢复查询404保留旧ID，显式重试不会创建另一逻辑请求", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  seedRequest(storage, C, A, "尚未登记的问题");
  const ui = await openApp(t, state, storage);
  assert.equal(chatCalls(state).length, 0);
  assert.equal(statusCalls(state).length, 1);
  assert.equal(storedRequests(storage)[0].requestId, C);
  await ui.get("#retry-request").emit("click");
  assert.equal(chatCalls(state).length, 1);
  assert.deepEqual(chatCalls(state)[0].body, { request_id: C, session_id: A, content: "尚未登记的问题" });
  assert.equal(state.histories.get(A).length, 2);
});

test("请求状态查询失败或超时保留原ID，恢复按钮可再次查询且不POST", async (t) => {
  const clock = deadlineClock(t);
  const state = server([session(A, "英语练习")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  seedRequest(storage, C, A, "状态未知的问题");
  state.onRequestStatus = () => Response.json({ detail: "状态服务暂不可用" }, { status: 503 });
  const ui = await openApp(t, state, storage);
  assert.equal(storedRequests(storage)[0].requestId, C);
  assert.equal(chatCalls(state).length, 0);
  const stalled = stalledRequest();
  state.onRequestStatus = (_requestId, _sessionId, options) => stalled.handle(options);
  const checking = ui.get("#check-request").emit("click");
  await stalled.started;
  clock.expire(10000);
  await checking;
  assert.equal(storedRequests(storage)[0].requestId, C);
  assert.equal(storedRequests(storage)[0].content, "状态未知的问题");
  assert.equal(chatCalls(state).length, 0);
  assertRecoverySettled(ui);
  state.onRequestStatus = null;
  await ui.get("#check-request").emit("click");
  assert.equal(storedRequests(storage)[0].requestId, C);
  assert.equal(chatCalls(state).length, 0);
});

test("GET确认成功但历史读取失败时保留真实回复，结果面板可安全恢复", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  seedRequest(storage, C, A, "历史不可用的问题");
  state.requests.set(C, {
    request_id: C, session_id: A, content: "历史不可用的问题", status: "succeeded",
    reply: "<img src=x onerror=alert(1)>实际收到的回复", error: null,
  });
  state.onHistory = () => Response.json({ detail: "历史服务不可用" }, { status: 503 });
  const ui = await openApp(t, state, storage);
  assert.equal(chatCalls(state).length, 0);
  assert.equal(storedRequests(storage)[0].status, "succeeded");
  assert.match(ui.get("#request-result").textContent, /实际收到的回复/);
  assert.match(ui.get("#request-result").textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(descendants(ui.get("#request-result")).some((node) => node.name === "img"), false);
  await ui.get("#new-request").emit("click");
  assert.equal(storedRequests(storage).length, 0);
  assert.equal(chatCalls(state).length, 0);
});

test("本地已保存终态可直接展示，不重复POST或要求重新执行模型", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  seedRequest(storage, C, A, "本地完成的问题", "failed", {
    error: { code: "MODEL_RESPONSE_ERROR", message: "本地已确认的错误" },
  });
  const ui = await openApp(t, state, storage);
  assert.equal(chatCalls(state).length, 0);
  assert.equal(statusCalls(state).length, 0);
  assert.match(ui.get("#request-note").textContent + ui.get("#request-result").textContent, /本地已确认的错误/);
  assert.equal(storedRequests(storage)[0].requestId, C);
});

test("请求保存失败时不POST，保留输入供存储恢复后重新发送", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map();
  const originalSet = storage.set.bind(storage);
  let denyRequests = true;
  storage.set = (key, value) => {
    if (denyRequests && key.startsWith(REQUEST_KEY_PREFIX)) throw new Error("storage full");
    return originalSet(key, value);
  };
  const ui = await openApp(t, state, storage);
  ui.get("#message-input").value = "保存失败不能丢失的输入";
  await ui.get("#chat-form").emit("submit");
  assert.equal(chatCalls(state).length, 0);
  assert.equal(ui.get("#message-input").value, "保存失败不能丢失的输入");
  assert.match(ui.get("#chat-error").textContent, /保存|存储/);
  assert.equal(storedRequests(storage).length, 0);
  denyRequests = false;
  await ui.get("#chat-form").emit("submit");
  assert.equal(chatCalls(state).length, 1);
  assert.match(ui.get("#message-list").textContent, /Hello!/);
});

test("多会话未决请求各自恢复，切换只查询当前会话且不混用ID", async (t) => {
  const state = server([session(A, "A会话"), session(B, "B会话")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  const requestB = "44444444-4444-4444-8444-444444444444";
  seedRequest(storage, C, A, "A原始请求");
  seedRequest(storage, requestB, B, "B原始请求");
  state.requests.set(C, { request_id: C, session_id: A, content: "A原始请求", status: "processing", reply: null, error: null });
  state.requests.set(requestB, { request_id: requestB, session_id: B, content: "B原始请求", status: "processing", reply: null, error: null });
  const ui = await openApp(t, state, storage);
  assert.equal(statusCalls(state).length, 1);
  assert.match(statusCalls(state)[0].url, new RegExp(C));
  await threadButton(ui, "B会话").emit("click");
  assert.equal(ui.storage.get("teresa.activeSessionId"), B);
  assert.equal(statusCalls(state).length, 2);
  const query = new URL(statusCalls(state)[1].url, "http://localhost");
  assert.equal(query.pathname, `/api/chat/requests/${requestB}`);
  assert.equal(query.searchParams.get("session_id"), B);
  assert.equal(storedRequests(storage).length, 2);
  assert.equal(chatCalls(state).length, 0);
});

test("已收到回复但终态存储失败，刷新与状态查询失败不能丢失已知结果", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map();
  const originalSet = storage.set.bind(storage);
  let denyCompleted = true;
  storage.set = (key, value) => {
    if (denyCompleted && key.startsWith(REQUEST_KEY_PREFIX)
      && JSON.parse(value).status === "succeeded") throw new Error("storage temporarily full");
    return originalSet(key, value);
  };
  const ui = await openApp(t, state, storage);
  state.onHistory = () => Response.json({ detail: "历史暂不可用" }, { status: 503 });
  ui.get("#message-input").value = "回复不能丢失的问题";
  await ui.get("#chat-form").emit("submit");
  const requestId = chatCalls(state)[0].body.request_id;
  assert.match(ui.get("#message-list").textContent, /Hello!/);
  assert.equal(storedRequests(storage)[0].requestId, requestId);
  assert.equal(storedRequests(storage)[0].status, "pending");

  denyCompleted = false;
  state.onHistory = () => Response.json([]);
  state.onRequestStatus = () => Response.json({ detail: "请求状态暂不可用" }, { status: 503 });
  await ui.get("#reload-history").emit("click");
  const visibleResult = () => [
    ui.get("#message-list").hidden ? "" : ui.get("#message-list").textContent,
    ui.get("#request-result").hidden ? "" : ui.get("#request-result").textContent,
  ].join("");
  assert.match(visibleResult(), /Hello!/);
  assert.equal(ui.get("#retry-request").hidden, true);
  assert.equal(ui.get("#new-request").hidden, false);
  await ui.get("#check-request").emit("click");
  assert.ok(statusCalls(state).length >= 1);
  assert.match(visibleResult(), /Hello!/);
  assert.match(ui.get("#request-note").textContent, /已完成/);
  assert.doesNotMatch(ui.get("#request-note").textContent, /结果暂时无法确认/);
  assert.equal(ui.get("#retry-request").hidden, true);
  assert.equal(ui.get("#new-request").hidden, false);
  assert.equal(chatCalls(state).length, 1);
});

test("GET确认旧请求成功且历史后面已有其他轮时，不额外重复展示旧回复", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  seedRequest(storage, C, A, "旧请求的问题");
  state.requests.set(C, {
    request_id: C, session_id: A, content: "旧请求的问题", status: "succeeded",
    reply: "原请求唯一回复", error: null,
  });
  state.histories.set(A, [
    { id: "old-user", role: "user", content: "旧请求的问题" },
    { id: "old-assistant", role: "assistant", content: "原请求唯一回复" },
    { id: "new-user", role: "user", content: "后面另一轮的问题" },
    { id: "new-assistant", role: "assistant", content: "后面另一轮的回复" },
  ]);
  const ui = await openApp(t, state, storage);
  assert.equal(statusCalls(state).length, 1);
  assert.equal(chatCalls(state).length, 0);
  assert.equal(ui.get("#message-list").children.length, 4);
  assert.match(ui.get("#message-list").textContent, /原请求唯一回复/);
  assert.match(ui.get("#message-list").textContent, /后面另一轮的回复/);
  assert.equal(ui.get("#request-result").hidden, true);
  assert.equal(ui.get("#request-result").textContent, "");
  assert.equal(ui.get("#message-list").textContent.match(/原请求唯一回复/g).length, 1);
});

test("本地已知失败的强制查询返回503时保留原错误且不退回未知状态", async (t) => {
  const state = server([session(A, "英语练习")]);
  const storage = new Map([["teresa.activeSessionId", A]]);
  seedRequest(storage, C, A, "已确认失败的问题", "failed", {
    error: { code: "MODEL_TIMEOUT", message: "原来已确认的模型超时" },
  });
  state.onRequestStatus = () => Response.json({ detail: "状态服务暂不可用" }, { status: 503 });
  const ui = await openApp(t, state, storage);
  assert.equal(statusCalls(state).length, 0);
  await ui.get("#check-request").emit("click");
  assert.equal(statusCalls(state).length, 1);
  assert.match(ui.get("#request-note").textContent, /已确认失败/);
  assert.match(ui.get("#request-note").textContent, /原来已确认的模型超时/);
  assert.doesNotMatch(ui.get("#request-note").textContent, /结果暂时无法确认/);
  assert.equal(ui.get("#retry-request").hidden, true);
  assert.equal(ui.get("#new-request").hidden, false);
  assert.equal(ui.get("#new-request").disabled, false);
  assert.equal(storedRequests(storage)[0].status, "failed");
  assert.equal(chatCalls(state).length, 0);
});
