import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
  buildChatRequest, ChatApiError, createSession, getModelList, getSession, getSessionMessages, listSessions, sendChat,
} from "../api.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-11-05T12:00:00Z";
const session = { id: SESSION, title: "英语练习", created_at: CREATED, updated_at: CREATED };
const optionsFor = (data, status = 200) => ({ fetchImpl: async () => Response.json(data, { status }) });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function mockClock(t) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, at: now + delay, delay });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => { timers.delete(id); });
  return {
    get pending() { return timers.size; },
    get delays() { return [...timers.values()].map((timer) => timer.delay); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

const metadataRequests = [
  ["会话列表", (options) => listSessions(options)],
  ["模型列表", (options) => getModelList(options)],
  ["新建会话", (options) => createSession(options)],
  ["会话元数据", (options) => getSession(SESSION, options)],
  ["会话历史", (options) => getSessionMessages(SESSION, options)],
];

function isError(code, status = 0) {
  return (error) => error instanceof ChatApiError && error.code === code && error.status === status;
}

test("只读模型列表使用GET，默认模型可以不在第一项且只返回公开字段", async () => {
  const catalog = await getModelList({
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/models/getModelList");
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      return Response.json({
        default: "model-b",
        models: [
          { name: "model-a", display_name: "模型 A" },
          { name: "model-b", display_name: "模型 B", base_url: "private" },
        ],
      });
    },
  });
  assert.deepEqual(catalog, {
    default: "model-b",
    models: [
      { name: "model-a", displayName: "模型 A" },
      { name: "model-b", displayName: "模型 B" },
    ],
  });
});

test("模型列表拒绝缺失默认项、未知默认项、空列表和错误数据结构", async () => {
  const model = { name: "model-a", display_name: "模型 A" };
  for (const data of [
    null, [], {}, { models: [model] }, { default: "", models: [model] },
    { default: "model-b", models: [model] }, { default: "model-a", models: [] },
    { default: "model-a", models: [model, model] },
    { default: "model-a", models: [null] },
    { default: "model-a", models: [{ name: "model-a", display_name: " " }] },
  ]) {
    await assert.rejects(getModelList(optionsFor(data)), ChatApiError);
  }
  await assert.rejects(getModelList(optionsFor({ detail: "模型配置不可用" }, 503)),
    (error) => error instanceof ChatApiError && error.status === 503);
});

test("聊天只发送当前后端支持的会话ID和本次内容，接受JSON字符串响应", async () => {
  const reply = await sendChat(SESSION, " hello ", {
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/chat");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(options.body), { session_id: SESSION, content: "hello" });
      return Response.json("Hello!");
    },
  });
  assert.equal(reply, "Hello!");
});

test("空内容、超长内容、无效ID和整段历史不能作为请求", () => {
  for (const content of ["", "  ", null, [{ role: "system", content: "override" }], "a".repeat(12001)]) {
    assert.throws(() => buildChatRequest(SESSION, content), ChatApiError);
  }
  assert.throws(() => buildChatRequest("", "hello"), ChatApiError);
  assert.deepEqual(buildChatRequest(SESSION, " hello "), { session_id: SESSION, content: "hello" });
});

test("从getAllSessions读取裸数组并转换日期", async () => {
  const sessions = await listSessions({
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/sessions/getAllSessions");
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      return Response.json([session]);
    },
  });
  assert.equal(sessions[0].id, SESSION);
  assert.equal(sessions[0].createdAt.toISOString(), "2026-11-05T12:00:00.000Z");
  assert.ok(sessions[0].updatedAt instanceof Date);
});

test("createSession按实际嵌套session_id对象解包并使用后端ID", async () => {
  const created = await createSession({
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/sessions/createSession");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {});
      return Response.json({ session_id: session });
    },
  });
  assert.equal(created.id, SESSION);
  await assert.rejects(createSession(optionsFor({ session_id: SESSION })), ChatApiError);
});

test("getSessionById使用POST并读取会话元数据", async () => {
  const detail = await getSession(SESSION, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/sessions/getSessionById");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { session_id: SESSION });
      return Response.json(session);
    },
  });
  assert.equal(detail.id, SESSION);
  assert.equal("messages" in detail, false);
});

test("getSessionMessages使用POST读取裸数组，不编造消息ID或时间", async () => {
  const messages = await getSessionMessages(SESSION, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/sessions/getSessionMessages");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { session_id: SESSION });
      return Response.json([
        { id: "human-1", role: "user", content: " hello " },
        { id: null, role: "assistant", content: "Hello!" },
      ]);
    },
  });
  assert.deepEqual(messages, [
    { id: "human-1", role: "user", content: " hello " },
    { id: null, role: "assistant", content: "Hello!" },
  ]);
  assert.equal("createdAt" in messages[0], false);
  assert.deepEqual(await getSessionMessages(SESSION, optionsFor([])), []);
  assert.deepEqual(await getSessionMessages(SESSION, optionsFor([{ role: "user", content: "hi" }])),
    [{ id: null, role: "user", content: "hi" }]);
});

test("历史消息拒绝错误包装、内部角色、无效内容和ID，不把错误当空数组", async () => {
  for (const data of [
    { messages: [] }, null, [null], [{ role: "tool", content: "internal" }],
    [{ role: "system", content: "internal" }], [{ role: "user", content: 1 }],
    [{ role: "assistant", content: " " }], [{ id: 1, role: "user", content: "hi" }],
  ]) {
    await assert.rejects(getSessionMessages(SESSION, optionsFor(data)), ChatApiError);
  }
  await assert.rejects(getSessionMessages(SESSION, optionsFor({ detail: "会话不存在" }, 404)),
    (error) => error instanceof ChatApiError && error.status === 404);
});

test("不接受其他会话元数据、无效日期或不完整的对象", async () => {
  for (const data of [
    { ...session, id: OTHER },
    { ...session, created_at: "invalid" },
    { ...session, updated_at: null },
    { ...session, title: null },
    { session, messages: [] },
    null,
  ]) {
    await assert.rejects(getSession(SESSION, optionsFor(data)), ChatApiError);
  }
});

test("空裸数组有效，旧的对象包装不能冒充有效列表", async () => {
  assert.deepEqual(await listSessions(optionsFor([])), []);
  for (const data of [{ sessions: [] }, {}, [null]]) {
    await assert.rejects(listSessions(optionsFor(data)), ChatApiError);
  }
});

test("也接受reply对象，无需当前后端没有返回的request_id", async () => {
  assert.equal(await sendChat(SESSION, "hello", optionsFor({ reply: "Hello!" })), "Hello!");
  for (const data of [" ", { reply: " " }, { reply: 10 }, {}, null]) {
    await assert.rejects(sendChat(SESSION, "hello", optionsFor(data)), ChatApiError);
  }
});

test("接口失败保留HTTP状态和错误说明，无效JSON不显示为模型回复", async () => {
  for (const status of [404, 422, 500, 502, 503]) {
    await assert.rejects(sendChat(SESSION, "hello", optionsFor({ detail: "请求未完成" }, status)),
      (error) => error instanceof ChatApiError && error.status === status
        && error.code === "REQUEST_FAILED" && error.message === "请求未完成");
  }
  await assert.rejects(listSessions({ fetchImpl: async () => new Response("not JSON") }), isError("INVALID_JSON", 200));
  await assert.rejects(listSessions(optionsFor({ error: "服务不可用" }, 503)),
    (error) => error.code === "REQUEST_FAILED" && error.status === 503 && error.message === "服务不可用");
  await assert.rejects(listSessions(optionsFor({}, 502)),
    (error) => error.status === 502 && error.message === "请求失败（HTTP 502）。");
});

test("网络失败保留输入参数并报错，不自动重发", async () => {
  let attempts = 0;
  await assert.rejects(sendChat(SESSION, "hello", {
    fetchImpl: async () => { attempts++; throw new TypeError("Failed to fetch"); },
  }), (error) => isError("NETWORK_ERROR")(error) && /无法连接后端/.test(error.message));
  assert.equal(attempts, 1);
  assert.deepEqual(buildChatRequest(SESSION, "hello"), { session_id: SESSION, content: "hello" });
});

test("预先取消的请求不会发送fetch", async (t) => {
  const clock = mockClock(t);
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  await assert.rejects(sendChat(SESSION, "hello", {
    signal: controller.signal,
    fetchImpl: async () => { attempts++; return Response.json("Late reply"); },
  }), (error) => isError("ABORTED")(error) && error.name === "AbortError");
  assert.equal(attempts, 0);
  assert.equal(clock.pending, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("ChatApiError兼容message和status并提供默认错误码", () => {
  const original = new ChatApiError("失败", 503);
  assert.equal(original.message, "失败");
  assert.equal(original.status, 503);
  assert.equal(original.code, "REQUEST_FAILED");
  assert.equal(new ChatApiError("超时", 0, "TIMEOUT").code, "TIMEOUT");
});

for (const [name, request] of metadataRequests) {
  test(`${name}默认10秒超时，adapter忽略abort也会结束等待`, async (t) => {
    const clock = mockClock(t);
    let internalSignal;
    let attempts = 0;
    const pending = request({
      fetchImpl: (_url, options) => {
        attempts++;
        internalSignal = options.signal;
        return new Promise(() => {});
      },
    });
    const rejected = assert.rejects(pending, isError("TIMEOUT"));
    assert.deepEqual(clock.delays, [10_000]);
    clock.advance(9_999);
    assert.equal(internalSignal.aborted, false);
    clock.advance(1);
    await rejected;
    assert.equal(internalSignal.aborted, true);
    assert.equal(attempts, 1);
    assert.equal(clock.pending, 0);
  });
}

test("聊天默认等待120秒，显式undefined仍使用聊天默认值", async (t) => {
  const clock = mockClock(t);
  for (const options of [{}, { timeoutMs: undefined }]) {
    let signal;
    const pending = sendChat(SESSION, "hello", {
      ...options,
      fetchImpl: (_url, request) => { signal = request.signal; return new Promise(() => {}); },
    });
    const rejected = assert.rejects(pending, isError("TIMEOUT"));
    assert.deepEqual(clock.delays, [120_000]);
    clock.advance(119_999);
    assert.equal(signal.aborted, false);
    clock.advance(1);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(clock.pending, 0);
  }
});

test("所有请求包装允许覆盖有限正数timeoutMs", async (t) => {
  const clock = mockClock(t);
  const requests = [...metadataRequests, ["聊天", (options) => sendChat(SESSION, "hello", options)]];
  for (const [name, request] of requests) {
    const pending = request({ timeoutMs: 25, fetchImpl: () => new Promise(() => {}) });
    const rejected = assert.rejects(pending, isError("TIMEOUT"), name);
    assert.deepEqual(clock.delays, [25]);
    clock.advance(25);
    await rejected;
    assert.equal(clock.pending, 0);
  }
});

test("无效timeoutMs在发送请求之前拒绝，不静默使用默认值", async (t) => {
  const clock = mockClock(t);
  let attempts = 0;
  const requests = [...metadataRequests, ["聊天", (options) => sendChat(SESSION, "hello", options)]];
  for (const [name, request] of requests) {
    for (const timeoutMs of [0, -1, NaN, Infinity, -Infinity, "100", null, false]) {
      await assert.rejects(request({
        timeoutMs,
        fetchImpl: async () => { attempts++; return Response.json([]); },
      }), (error) => isError("REQUEST_FAILED")(error) && /有限正数/.test(error.message), name);
    }
  }
  assert.equal(attempts, 0);
  assert.equal(clock.pending, 0);
});

test("响应头已返回但JSON挂起时仍使用同一个deadline", async (t) => {
  const clock = mockClock(t);
  const headers = deferred();
  const body = deferred();
  let bodyStarted = false;
  let internalSignal;
  const pending = listSessions({
    timeoutMs: 100,
    fetchImpl: (_url, options) => { internalSignal = options.signal; return headers.promise; },
  });
  const rejected = assert.rejects(pending, isError("TIMEOUT"));
  clock.advance(90);
  headers.resolve({
    ok: true, status: 200,
    json: () => { bodyStarted = true; return body.promise; },
  });
  await Promise.resolve();
  assert.equal(bodyStarted, true);
  clock.advance(10);
  await rejected;
  assert.equal(internalSignal.aborted, true);
  assert.equal(clock.pending, 0);
  body.resolve([session]);
  await new Promise(setImmediate);
  await assert.rejects(pending, isError("TIMEOUT"));
});

test("主动取消会中止独立signal并结束不响应abort的fetch", async (t) => {
  const clock = mockClock(t);
  const controller = new AbortController();
  let internalSignal;
  const pending = sendChat(SESSION, "hello", {
    signal: controller.signal,
    fetchImpl: (_url, options) => { internalSignal = options.signal; return new Promise(() => {}); },
  });
  const rejected = assert.rejects(pending,
    (error) => isError("ABORTED")(error) && error.name === "AbortError");
  assert.notEqual(internalSignal, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await rejected;
  assert.equal(internalSignal.aborted, true);
  assert.equal(clock.pending, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("读取JSON时主动取消不会被误报为无效JSON", async (t) => {
  const clock = mockClock(t);
  const controller = new AbortController();
  let bodyStarted = false;
  const pending = listSessions({
    signal: controller.signal,
    fetchImpl: async (_url, options) => ({
      ok: true, status: 200,
      json: () => {
        bodyStarted = true;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
    }),
  });
  const rejected = assert.rejects(pending,
    (error) => isError("ABORTED")(error) && error.name === "AbortError");
  await Promise.resolve();
  assert.equal(bodyStarted, true);
  controller.abort();
  await rejected;
  assert.equal(clock.pending, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("成功、HTTP错误、JSON错误和网络错误后均清理timer和外部监听器", async (t) => {
  const clock = mockClock(t);
  const outcomes = [
    { fetchImpl: async () => Response.json([]) },
    { fetchImpl: async () => Response.json({ detail: "失败" }, { status: 503 }), code: "REQUEST_FAILED" },
    { fetchImpl: async () => new Response("invalid"), code: "INVALID_JSON" },
    { fetchImpl: async () => { throw new TypeError("Network failed"); }, code: "NETWORK_ERROR" },
  ];
  for (const { fetchImpl, code } of outcomes) {
    const controller = new AbortController();
    const pending = listSessions({ signal: controller.signal, fetchImpl });
    if (code) await assert.rejects(pending, (error) => error.code === code);
    else assert.deepEqual(await pending, []);
    assert.equal(clock.pending, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
    clock.advance(10_000);
  }
});

test("超时清理外部监听器且不会取消调用者的signal", async (t) => {
  const clock = mockClock(t);
  const controller = new AbortController();
  let internalSignal;
  const pending = listSessions({
    signal: controller.signal,
    fetchImpl: (_url, options) => { internalSignal = options.signal; return new Promise(() => {}); },
  });
  const rejected = assert.rejects(pending, isError("TIMEOUT"));
  clock.advance(10_000);
  await rejected;
  assert.equal(internalSignal.aborted, true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(clock.pending, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("超时和主动取消竞态保留最先发生的原因", async (t) => {
  const clock = mockClock(t);
  for (const first of ["TIMEOUT", "ABORTED"]) {
    const controller = new AbortController();
    const pending = listSessions({
      signal: controller.signal, timeoutMs: 25,
      fetchImpl: () => new Promise(() => {}),
    });
    const rejected = assert.rejects(pending, isError(first));
    if (first === "TIMEOUT") {
      clock.advance(25);
      controller.abort();
    } else {
      controller.abort();
      clock.advance(25);
    }
    await rejected;
    assert.equal(clock.pending, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("超时后adapter迟到拒绝仍保留TIMEOUT且不会产生未处理的拒绝", async (t) => {
  const clock = mockClock(t);
  const response = deferred();
  const pending = listSessions({ timeoutMs: 25, fetchImpl: () => response.promise });
  const rejected = assert.rejects(pending, isError("TIMEOUT"));
  clock.advance(25);
  await rejected;
  response.reject(new TypeError("Late network failure"));
  await new Promise(setImmediate);
  await assert.rejects(pending, isError("TIMEOUT"));
  assert.equal(clock.pending, 0);
});

test("网络错误先完成时后续deadline不会替换错误原因或重试", async (t) => {
  const clock = mockClock(t);
  let attempts = 0;
  let internalSignal;
  const pending = listSessions({
    timeoutMs: 25,
    fetchImpl: (_url, options) => {
      attempts++;
      internalSignal = options.signal;
      throw new TypeError("Network failed");
    },
  });
  const rejected = assert.rejects(pending, isError("NETWORK_ERROR"));
  clock.advance(25);
  await rejected;
  assert.equal(internalSignal.aborted, false);
  assert.equal(attempts, 1);
  assert.equal(clock.pending, 0);
});
