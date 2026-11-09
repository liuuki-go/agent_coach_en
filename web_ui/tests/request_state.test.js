import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatRequest, getChatRequests, removeChatRequest, saveChatRequest,
} from "../request_state.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FIRST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "teresa.chatRequest.";
const CREATED = "2026-11-09T10:00:00.000Z";

function fixture(t) {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  t.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else delete globalThis.localStorage;
  });
  return { values, storage };
}

const record = (changes = {}) => ({
  requestId: FIRST, sessionId: SESSION, content: "Hello", status: "pending",
  createdAt: CREATED, ...changes,
});

test("创建时只生成一次安全 UUID，保存实际发送文字后才返回", (t) => {
  const { values } = fixture(t);
  let uuidCalls = 0;
  t.mock.method(globalThis.crypto, "randomUUID", () => { uuidCalls++; return FIRST; });
  t.mock.method(Math, "random", () => { throw new Error("不能使用 Math.random"); });

  const created = createChatRequest(SESSION, "  Hello\n  Teresa!  ");

  assert.equal(uuidCalls, 1);
  assert.equal(created.requestId, FIRST);
  assert.equal(created.sessionId, SESSION);
  assert.equal(created.content, "Hello\n  Teresa!");
  assert.equal(created.status, "pending");
  assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);
  assert.deepEqual(JSON.parse(values.get(`${PREFIX}${FIRST}`)), created);
});

test("非法输入在生成标识和写入前拒绝", (t) => {
  const { values } = fixture(t);
  const uuid = t.mock.method(globalThis.crypto, "randomUUID", () => FIRST);
  for (const [sessionId, content] of [
    ["bad-id", "Hello"], [SESSION, null], [SESSION, 12], [SESSION, " \n "],
    [SESSION, "x".repeat(12001)],
  ]) {
    assert.throws(() => createChatRequest(sessionId, content), Error);
  }
  assert.equal(uuid.mock.callCount(), 0);
  assert.equal(values.size, 0);
});

test("安全 UUID 不可用或返回非法值时拒绝创建，不退回随机数", (t) => {
  const { values } = fixture(t);
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  t.after(() => Object.defineProperty(globalThis, "crypto", cryptoDescriptor));
  assert.throws(() => createChatRequest(SESSION, "Hello"), /安全生成请求标识/);
  globalThis.crypto.randomUUID = () => "not-a-uuid";
  assert.throws(() => createChatRequest(SESSION, "Hello"), /请求标识无效/);
  assert.equal(values.size, 0);
});

test("重新加载从存储恢复请求，同会话不同 ID 和其他会话各自保留", async (t) => {
  const { values } = fixture(t);
  values.set("teresa.activeSessionId", SESSION);
  saveChatRequest(record({ requestId: SECOND }));
  saveChatRequest(record());
  const third = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  saveChatRequest(record({ requestId: third, sessionId: OTHER }));

  const reloaded = await import(`../request_state.js?reload=${Date.now()}`);
  assert.deepEqual(reloaded.getChatRequests(SESSION).map((item) => item.requestId), [FIRST, SECOND]);
  assert.deepEqual(reloaded.getChatRequests(OTHER).map((item) => item.requestId), [third]);
  assert.equal(values.get("teresa.activeSessionId"), SESSION);
});

test("请求按创建时间再按标识排序，返回对象的修改不影响已保存记录", (t) => {
  fixture(t);
  saveChatRequest(record());
  saveChatRequest(record({ requestId: SECOND, createdAt: "2026-11-08T10:00:00.000Z" }));

  const restored = getChatRequests(SESSION);
  assert.deepEqual(restored.map((item) => item.requestId), [SECOND, FIRST]);
  restored[0].content = "Changed only in memory";
  assert.equal(getChatRequests(SESSION)[0].content, "Hello");
});

test("成功和失败结果可跨页面恢复，只保存当前请求的白名单字段", (t) => {
  const { values } = fixture(t);
  saveChatRequest(record());
  saveChatRequest(record({ status: "succeeded", reply: "  A real reply  ", error: null, messages: ["history"] }));
  saveChatRequest(record({ requestId: SECOND }));
  saveChatRequest(record({
    requestId: SECOND, status: "failed", reply: null,
    error: { code: "MODEL_TIMEOUT", message: "模型响应超时", stack: "private" },
  }));

  const restored = getChatRequests(SESSION);
  assert.equal(restored[0].reply, "  A real reply  ");
  assert.deepEqual(restored[1].error, { code: "MODEL_TIMEOUT", message: "模型响应超时" });
  assert.equal(values.get(`${PREFIX}${FIRST}`).includes("messages"), false);
  assert.equal(values.get(`${PREFIX}${SECOND}`).includes("private"), false);
});

test("同 ID 的会话、内容和创建时间不可修改", (t) => {
  fixture(t);
  saveChatRequest(record());
  for (const changes of [
    { sessionId: OTHER }, { content: "Different question" },
    { createdAt: "2026-11-08T10:00:00.000Z" },
  ]) {
    assert.throws(() => saveChatRequest(record(changes)), /不能更改/);
    assert.deepEqual(getChatRequests(SESSION), [record()]);
  }
});

test("已确认结果不能改回 pending 或被其他结果覆盖，可重复保存相同终态", (t) => {
  fixture(t);
  for (const terminal of [
    record({ status: "succeeded", reply: "Saved reply" }),
    record({ status: "failed", error: { code: "MODEL_TIMEOUT", message: "超时" } }),
  ]) {
    removeChatRequest(FIRST);
    saveChatRequest(record());
    saveChatRequest(terminal);
    saveChatRequest(terminal);
    assert.throws(() => saveChatRequest(record()), /已经确认/);
    const changed = terminal.status === "succeeded"
      ? record({ status: "succeeded", reply: "Overwritten reply" })
      : record({ status: "succeeded", reply: "Unexpected success" });
    assert.throws(() => saveChatRequest(changed), /已经确认/);
    assert.deepEqual(getChatRequests(SESSION), [terminal]);
  }
});

test("重复生成已有 ID 时不覆盖记录或重新生成另一个 ID", (t) => {
  fixture(t);
  saveChatRequest(record());
  const uuid = t.mock.method(globalThis.crypto, "randomUUID", () => FIRST);
  assert.throws(() => createChatRequest(SESSION, "Another input"), /已经存在/);
  assert.equal(uuid.mock.callCount(), 1);
  assert.deepEqual(getChatRequests(SESSION), [record()]);
});

test("精确移除当前 ID，不删除其他请求、会话选择或聊天数据", (t) => {
  const { values } = fixture(t);
  saveChatRequest(record());
  saveChatRequest(record({ requestId: SECOND, sessionId: OTHER }));
  values.set("teresa.activeSessionId", SESSION);

  removeChatRequest(FIRST);
  removeChatRequest(FIRST);

  assert.equal(values.has(`${PREFIX}${FIRST}`), false);
  assert.equal(values.has(`${PREFIX}${SECOND}`), true);
  assert.equal(values.get("teresa.activeSessionId"), SESSION);
  assert.throws(() => removeChatRequest("bad-id"), /请求标识无效/);
});

test("损坏 JSON、标识或状态组合明确报错，不自动删除或重建", (t) => {
  const { values } = fixture(t);
  for (const raw of [
    "{broken", "null", JSON.stringify(record({ requestId: SECOND })),
    JSON.stringify(record({ sessionId: "bad-id" })),
    JSON.stringify(record({ createdAt: "yesterday" })),
    JSON.stringify(record({ status: "unknown" })),
    JSON.stringify(record({ status: "succeeded" })),
    JSON.stringify(record({ status: "failed", error: { code: "FAIL", message: 1 } })),
    JSON.stringify(record({ status: "failed", error: [] })),
    JSON.stringify(record({ reply: "A conflicting result" })),
  ]) {
    values.set(`${PREFIX}${FIRST}`, raw);
    assert.throws(() => getChatRequests(SESSION), Error);
    assert.equal(values.get(`${PREFIX}${FIRST}`), raw);
    assert.throws(() => saveChatRequest(record()), Error);
    assert.equal(values.get(`${PREFIX}${FIRST}`), raw);
  }
});

test("存储权限、读取、枚举、写入和删除失败均向调用方报错", (t) => {
  const { storage } = fixture(t);
  const uuid = t.mock.method(globalThis.crypto, "randomUUID", () => FIRST);
  const fail = () => { throw new Error("Storage unavailable"); };
  const set = t.mock.method(storage, "setItem", fail);
  assert.throws(() => createChatRequest(SESSION, "Hello"), /无法保存/);
  assert.equal(uuid.mock.callCount(), 1);
  set.mock.restore();
  const get = t.mock.method(storage, "getItem", fail);
  assert.throws(() => saveChatRequest(record()), /无法读取/);
  get.mock.restore();
  const enumerate = t.mock.method(storage, "key", fail);
  storage.setItem(`${PREFIX}${FIRST}`, JSON.stringify(record()));
  assert.throws(() => getChatRequests(SESSION), /无法读取.*列表/);
  enumerate.mock.restore();
  t.mock.method(storage, "removeItem", fail);
  assert.throws(() => removeChatRequest(FIRST), /无法移除/);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: fail });
  assert.throws(() => saveChatRequest(record()), /无法访问/);
});

test("状态字段冲突、空回复和不规范原文不会写入", (t) => {
  const { values } = fixture(t);
  for (const invalid of [
    record({ status: "succeeded", reply: " " }),
    record({ status: "succeeded", reply: "Hi", error: { code: "FAIL", message: "失败" } }),
    record({ status: "failed", reply: "Hi", error: { code: "FAIL", message: "失败" } }),
    record({ status: "failed", error: { code: " ", message: "失败" } }),
    record({ content: " Hello " }),
  ]) assert.throws(() => saveChatRequest(invalid), Error);
  assert.equal(values.size, 0);
});
