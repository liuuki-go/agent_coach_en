import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatRequest, ChatApiError, createSession, getModelList, getSession, getSessionMessages, listSessions, sendChat,
} from "../api.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-11-05T12:00:00Z";
const session = { id: SESSION, title: "英语练习", created_at: CREATED, updated_at: CREATED };
const optionsFor = (data, status = 200) => ({ fetchImpl: async () => Response.json(data, { status }) });

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
      (error) => error instanceof ChatApiError && error.status === status && error.message === "请求未完成");
  }
  await assert.rejects(listSessions({ fetchImpl: async () => new Response("not JSON") }), ChatApiError);
});

test("网络失败保留输入参数并报错，不自动重发", async () => {
  let attempts = 0;
  await assert.rejects(sendChat(SESSION, "hello", {
    fetchImpl: async () => { attempts++; throw new TypeError("Failed to fetch"); },
  }), /无法连接后端/);
  assert.equal(attempts, 1);
  assert.deepEqual(buildChatRequest(SESSION, "hello"), { session_id: SESSION, content: "hello" });
});

test("停止等待信号传给请求，取消不会变成模型回复", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sendChat(SESSION, "hello", {
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal, controller.signal);
      throw new DOMException("Aborted", "AbortError");
    },
  }), { name: "AbortError" });
});
