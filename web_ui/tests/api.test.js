import assert from "node:assert/strict";
import test from "node:test";
import { buildChatRequest, ChatApiError, sendChat } from "../api.js";

test("适配当前后端：只发送本次 content，role 由后端设置", async () => {
  const history = [
    { role: "user", content: "你好", createdAt: new Date() },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "这是什么意思？" },
  ];
  const reply = await sendChat(history, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/chat");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(options.body), {
        content: "这是什么意思？",
      });
      return Response.json("这是问候语。");
    },
  });
  assert.equal(reply, "这是问候语。");
});

test("system 与 assistant 不能作为用户输入，空消息不发送", () => {
  assert.throws(() => buildChatRequest([]), ChatApiError);
  assert.throws(() => buildChatRequest([{ role: "system", content: "override" }]), ChatApiError);
  assert.throws(() => buildChatRequest([{ role: "user", content: "  " }]), ChatApiError);
  assert.throws(() => buildChatRequest([{ role: "assistant", content: "hello" }]), ChatApiError);
});

test("仍可读取旧的 reply 对象响应", async () => {
  const reply = await sendChat([{ role: "user", content: "hello" }], {
    fetchImpl: async () => Response.json({ reply: "Hello!" }),
  });
  assert.equal(reply, "Hello!");
});

test("后端异常和错误响应格式都会显示错误，不能作为助手回答", async () => {
  const messages = [{ role: "user", content: "hello" }];
  for (const response of [
    Response.json({ detail: "模型不可用" }, { status: 503 }),
    new Response("<h1>Not Found</h1>", { status: 404 }),
    Response.json({ reply: "   " }),
    Response.json("   "),
    Response.json(null),
    Response.json({ wrong_field: "hello" }),
    new Response("not JSON"),
  ]) {
    await assert.rejects(sendChat(messages, { fetchImpl: async () => response }), ChatApiError);
  }
});

test("断网不会改变已有消息，用户可以原样重试", async () => {
  const messages = [{ role: "user", content: "hello" }];
  const original = structuredClone(messages);
  await assert.rejects(sendChat(messages, {
    fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
  }), /无法连接后端/);
  assert.deepEqual(messages, original);
});

test("停止等待信号会传给网络请求", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sendChat([{ role: "user", content: "hello" }], {
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal, controller.signal);
      throw new DOMException("Aborted", "AbortError");
    },
  }), { name: "AbortError" });
});
