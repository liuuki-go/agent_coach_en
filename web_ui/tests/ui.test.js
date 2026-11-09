import assert from "node:assert/strict";
import test from "node:test";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const DATE = "2026-11-05T12:00:00Z";
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
    calls: [],
    onChat: null,
    onHistory: null,
    onModels: null,
    onList: null,
    onSession: null,
    onCreate: null,
    modelCatalog: {
      default: "model-b",
      models: [
        { name: "model-a", display_name: "模型 A" },
        { name: "model-b", display_name: "模型 B" },
      ],
    },
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
      if (state.onChat) return state.onChat(body, options);
      state.histories.get(body.session_id).push(
        { id: null, role: "user", content: body.content },
        { id: null, role: "assistant", content: "Hello!" },
      );
      return Response.json("Hello!");
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
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
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
  assert.deepEqual(chatCalls(state)[0].body, { session_id: A, content: "正常聊天" });
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
  assert.deepEqual(chatCalls(state)[0].body, { session_id: A, content: "模型列表失败时继续聊天" });
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

test("新建使用后端ID，聊天只发两个字段，本页切换保留真实回复", async (t) => {
  const state = server([session(A, "旧会话")]);
  const ui = await openApp(t, state);
  await ui.get("#new-chat").emit("click");
  assert.equal(ui.storage.get("teresa.activeSessionId"), B);
  assert.equal(ui.get("#message-list").children.length, 0);
  ui.get("#message-input").value = "本次新问题";
  await ui.get("#chat-form").emit("submit");
  assert.deepEqual(chatCalls(state)[0].body, { session_id: B, content: "本次新问题" });
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

test("停止只取消等待，保留草稿并提示重复风险，不自动重新发送", async (t) => {
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
  assert.equal(ui.get("#message-input").value, "稍后回复的问题");
  assert.match(ui.get("#chat-error").textContent, /后端可能仍在处理/);
  assert.match(ui.get("#chat-error").textContent, /重新发送可能重复执行/);
  assert.equal(ui.get("#message-list").children.length, 0);
  assert.equal(chatCalls(state).length, 1);
  assert.equal(state.calls.filter((call) => call.url === "/api/sessions/getSessionById").length, 1);
  state.onChat = null;
  await ui.get("#chat-form").emit("submit");
  assert.equal(chatCalls(state).length, 2);
  assert.deepEqual(chatCalls(state)[1].body, { session_id: A, content: "稍后回复的问题" });
  assert.equal(ui.get("#message-list").children.length, 2);
});

test("超时停止等待也保留草稿，不能承诺服务端取消或幂等恢复", async (t) => {
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
  assert.equal(ui.get("#message-input").value, "超时的问题");
  assert.match(ui.get("#chat-error").textContent, /等待超过两分钟/);
  assert.match(ui.get("#chat-error").textContent, /重新发送可能重复执行/);
  assert.equal(chatCalls(state).length, 1);
});

test("响应丢失无法读取后台结果，保留输入供用户决定，失败不会伪造消息", async (t) => {
  const state = server([session(A, "英语练习")]);
  let attempts = 0;
  state.onChat = () => {
    if (++attempts === 1) throw new TypeError("response lost after processing");
    return Response.json("真实收到的回复");
  };
  const ui = await openApp(t, state);
  ui.get("#message-input").value = "网络测试";
  await ui.get("#chat-form").emit("submit");
  assert.equal(ui.get("#message-input").value, "网络测试");
  assert.match(ui.get("#chat-error").textContent, /后端可能已执行/);
  assert.match(ui.get("#chat-error").textContent, /重新发送可能重复执行/);
  assert.equal(ui.get("#message-list").children.length, 0);
  assert.equal(chatCalls(state).length, 1);
  await ui.get("#chat-form").emit("submit");
  assert.equal(chatCalls(state).length, 2);
  assert.equal(ui.get("#message-list").children.length, 2);
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
  assertReady(ui);
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

test("聊天响应头到达后body挂起仍按聊天超时恢复草稿，不能误报无效JSON", async (t) => {
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
  assert.equal(ui.get("#message-input").value, "body未完成的问题");
  assert.equal(ui.get("#message-list").children.length, 0);
  assert.match(ui.get("#chat-error").textContent, /等待超过两分钟/);
  assert.match(ui.get("#chat-error").textContent, /后端可能仍在处理/);
  assert.match(ui.get("#chat-error").textContent, /重新发送可能重复执行/);
  assert.doesNotMatch(ui.get("#chat-error").textContent, /无效.*JSON/);
  assert.equal(chatCalls(state).length, 1);
  assertReady(ui);
});
