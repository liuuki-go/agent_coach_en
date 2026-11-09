import unittest
from unittest.mock import Mock, patch
from uuid import UUID

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from src.domains.chat_domain import UserMessage
from src.domains.error_domain import ChatError
from src.router import chat_api


def saved_request(request_id, session_id, status="succeeded"):
    return {
        "request_id": request_id,
        "session_id": session_id,
        "content": "不应出现在状态响应中的原始消息",
        "status": status,
        "reply": "Saved reply" if status == "succeeded" else None,
        "error_code": "MODEL_TIMEOUT" if status == "failed" else None,
        "error_message": "模型响应超时" if status == "failed" else None,
        "created_at": "2026-11-09T12:00:00Z",
        "updated_at": "2026-11-09T12:01:00Z",
    }


class ChatApiTests(unittest.TestCase):
    session_id = UUID("11111111-1111-4111-8111-111111111111")
    request_id = UUID("22222222-2222-4222-8222-222222222222")

    def setUp(self):
        self.agent = Mock()
        self.session_store = Mock()
        self.session_locks = Mock()
        self.request_store = Mock()
        self.message_store = Mock()
        for name, value in [
            ("agent", self.agent),
            ("session_store", self.session_store),
            ("session_locks", self.session_locks),
            ("request_store", self.request_store),
            ("message_store", self.message_store),
        ]:
            patcher = patch.object(chat_api.app.state, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(chat_api, "send_message", return_value="Hello")
        self.send_message = patcher.start()
        self.addCleanup(patcher.stop)

    def test_route_passes_explicit_dependencies_and_preserves_the_original_content(self):
        content = "  你好，Teresa!\nLet's practise English.  "

        reply = chat_api.chat(UserMessage(session_id=self.session_id, content=content))

        self.assertEqual(reply, "Hello")
        self.send_message.assert_called_once_with(
            session_id=self.session_id,
            content=content,
            agent=self.agent,
            session_store=self.session_store,
            session_locks=self.session_locks,
            request_id=None,
            request_store=self.request_store,
            message_store=self.message_store,
        )

    def test_request_id_is_converted_to_uuid_and_forwarded_with_the_store(self):
        request = UserMessage(
            session_id=str(self.session_id), content="Hello", request_id=str(self.request_id),
        )

        self.assertEqual(chat_api.chat(request), "Hello")
        self.send_message.assert_called_once_with(
            session_id=self.session_id,
            content="Hello",
            agent=self.agent,
            session_store=self.session_store,
            session_locks=self.session_locks,
            request_id=self.request_id,
            request_store=self.request_store,
            message_store=self.message_store,
        )

    def test_request_id_is_optional_but_must_be_a_uuid_when_provided(self):
        self.assertIsNone(UserMessage(session_id=self.session_id, content="Hello").request_id)
        self.assertIsNone(UserMessage(
            session_id=self.session_id, content="Hello", request_id=None,
        ).request_id)
        for request_id in ["invalid-id", "", 123, {}, []]:
            with self.subTest(request_id=request_id):
                with self.assertRaises(ValidationError):
                    UserMessage(session_id=self.session_id, content="Hello", request_id=request_id)
        self.send_message.assert_not_called()

    def test_invalid_content_is_rejected_before_calling_the_service(self):
        for content in ["", " \t\r\n ", "a" * 12001]:
            with self.subTest(content_length=len(content)):
                with self.assertRaises(HTTPException) as raised:
                    chat_api.chat(UserMessage(session_id=self.session_id, content=content))
                self.assertEqual(raised.exception.status_code, 400)
                self.send_message.assert_not_called()

    def test_content_at_the_length_limit_is_accepted(self):
        self.assertEqual(
            chat_api.chat(UserMessage(session_id=self.session_id, content="a" * 12000)),
            "Hello",
        )
        self.send_message.assert_called_once()

    def test_invalid_session_id_is_rejected_when_model_validation_is_bypassed(self):
        request = UserMessage.model_construct(session_id="invalid-id", content="Hello")

        with self.assertRaises(HTTPException) as raised:
            chat_api.chat(request)

        self.assertEqual(raised.exception.status_code, 400)
        self.send_message.assert_not_called()

    def test_business_errors_keep_the_existing_http_status_contract(self):
        for code, status in [
            ("SESSION_NOT_FOUND", 404),
            ("SESSION_BUSY", 409),
            ("MODEL_TIMEOUT", 504),
            ("MODEL_UNAVAILABLE", 503),
            ("MODEL_RESPONSE_ERROR", 502),
            ("CHAT_FAILED", 500),
            ("REQUEST_ID_CONFLICT", 409),
            ("REQUEST_PROCESSING", 409),
            ("REQUEST_STATE_UNKNOWN", 503),
            ("REQUEST_NOT_FOUND", 404),
            ("CONTEXT_LIMIT_EXCEEDED", 413),
            ("CONTEXT_STATE_INVALID", 409),
        ]:
            with self.subTest(code=code):
                self.send_message.side_effect = ChatError(code, "公开错误说明")
                with self.assertRaises(HTTPException) as raised:
                    chat_api.chat(UserMessage(session_id=self.session_id, content="Hello"))
                self.assertEqual(raised.exception.status_code, status)
                self.assertEqual(raised.exception.detail, "公开错误说明")


class RequestStatusApiTests(unittest.TestCase):
    session_id = UUID("11111111-1111-4111-8111-111111111111")
    request_id = UUID("22222222-2222-4222-8222-222222222222")

    def setUp(self):
        self.session_store = Mock()
        self.session_store.get_session.return_value = {"id": self.session_id}
        self.request_store = Mock()
        for name, value in [
            ("session_store", self.session_store),
            ("request_store", self.request_store),
        ]:
            patcher = patch.object(chat_api.app.state, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_status_read_uses_the_real_service_without_invoking_agent_or_writing(self):
        self.request_store.get_request.return_value = saved_request(self.request_id, self.session_id)

        with patch("src.service.chat_service.invoke") as invoke:
            response = chat_api.get_chat_request(self.request_id, self.session_id)

        self.assertEqual(response.reply, "Saved reply")
        self.session_store.get_session.assert_called_once_with(self.session_id)
        self.request_store.get_request.assert_called_once_with(self.request_id)
        self.request_store.try_start.assert_not_called()
        self.request_store.mark_succeeded.assert_not_called()
        self.request_store.mark_failed.assert_not_called()
        self.session_store.touch_session.assert_not_called()
        invoke.assert_not_called()

    def test_each_status_exposes_only_public_result_fields(self):
        for status in ["processing", "succeeded", "failed"]:
            with self.subTest(status=status):
                record = saved_request(self.request_id, self.session_id, status)
                with patch.object(chat_api, "get_request_status", return_value=record) as read_status:
                    response = chat_api.get_chat_request(self.request_id, self.session_id)
                read_status.assert_called_once_with(
                    session_id=self.session_id, request_id=self.request_id,
                    session_store=self.session_store, request_store=self.request_store,
                )
                self.assertEqual(response.model_dump(mode="json"), {
                    "request_id": str(self.request_id),
                    "session_id": str(self.session_id),
                    "status": status,
                    "reply": "Saved reply" if status == "succeeded" else None,
                    "error": {"code": "MODEL_TIMEOUT", "message": "模型响应超时"}
                    if status == "failed" else None,
                })

    def test_missing_request_and_another_sessions_request_are_not_found(self):
        for record in [None, saved_request(self.request_id, UUID("33333333-3333-4333-8333-333333333333"))]:
            with self.subTest(record=record):
                self.request_store.get_request.return_value = record
                with self.assertRaises(HTTPException) as raised:
                    chat_api.get_chat_request(self.request_id, self.session_id)
                self.assertEqual(raised.exception.status_code, 404)
                self.assertEqual(raised.exception.detail, "请求不存在")
                self.assertNotIn("Saved reply", raised.exception.detail)

    def test_missing_session_returns_404_without_reading_the_request(self):
        self.session_store.get_session.return_value = None

        with self.assertRaises(HTTPException) as raised:
            chat_api.get_chat_request(self.request_id, self.session_id)

        self.assertEqual(raised.exception.status_code, 404)
        self.request_store.get_request.assert_not_called()

    def test_database_read_failures_return_safe_503(self):
        for failing_store in [self.session_store.get_session, self.request_store.get_request]:
            with self.subTest(failing_store=failing_store):
                failing_store.side_effect = RuntimeError("private database connection details")
                try:
                    with self.assertLogs("src.service.chat_service", level="ERROR"):
                        with self.assertRaises(HTTPException) as raised:
                            chat_api.get_chat_request(self.request_id, self.session_id)
                    self.assertEqual(raised.exception.status_code, 503)
                    self.assertNotIn("private database", raised.exception.detail)
                finally:
                    failing_store.side_effect = None


class MessageHistoryApiTests(unittest.TestCase):
    session_id = UUID("11111111-1111-4111-8111-111111111111")
    other_session_id = UUID("33333333-3333-4333-8333-333333333333")
    request_id = UUID("22222222-2222-4222-8222-222222222222")

    def setUp(self):
        self.session_store = Mock()
        self.session_store.get_session.return_value = {"id": self.session_id}
        self.message_store = Mock()
        self.agent = Mock()
        self.agent.get_state.side_effect = AssertionError("聊天档案不应读取 Agent 状态")
        for name, value in [
            ("session_store", self.session_store),
            ("message_store", self.message_store),
            ("agent", self.agent),
        ]:
            patcher = patch.object(chat_api.app.state, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def message(self, message_id, role, content, session_id=None):
        return {
            "id": UUID(message_id),
            "sequence": 10 if role == "user" else 11,
            "session_id": session_id or self.session_id,
            "request_id": self.request_id,
            "role": role,
            "content": content,
            "created_at": "2026-11-09T12:00:00Z",
        }

    def test_history_reads_business_archive_and_exposes_only_existing_public_fields(self):
        self.message_store.list_messages.return_value = [
            self.message("44444444-4444-4444-8444-444444444444", "user", "原始问题"),
            self.message("55555555-5555-4555-8555-555555555555", "assistant", "已归档的回复"),
        ]

        result = chat_api.get_session_messages(
            chat_api.GetSessionByIdRequest(session_id=self.session_id),
        )

        self.assertEqual([message.model_dump() for message in result], [
            {"id": "44444444-4444-4444-8444-444444444444", "role": "user", "content": "原始问题"},
            {"id": "55555555-5555-4555-8555-555555555555", "role": "assistant", "content": "已归档的回复"},
        ])
        self.session_store.get_session.assert_called_once_with(self.session_id)
        self.message_store.list_messages.assert_called_once_with(self.session_id)
        self.agent.get_state.assert_not_called()
        self.agent.invoke.assert_not_called()

    def test_empty_archive_stays_empty_even_if_agent_contains_old_messages(self):
        self.message_store.list_messages.return_value = []

        result = chat_api.get_session_messages(
            chat_api.GetSessionByIdRequest(session_id=self.session_id),
        )

        self.assertEqual(result, [])
        self.message_store.list_messages.assert_called_once_with(self.session_id)
        self.agent.get_state.assert_not_called()

    def test_history_uses_the_requested_session_for_each_archive_lookup(self):
        def list_messages(session_id):
            return [self.message(
                "44444444-4444-4444-8444-444444444444", "user", str(session_id), session_id,
            )]

        self.message_store.list_messages.side_effect = list_messages
        for session_id in [self.session_id, self.other_session_id]:
            with self.subTest(session_id=session_id):
                result = chat_api.get_session_messages(
                    chat_api.GetSessionByIdRequest(session_id=session_id),
                )
                self.assertEqual(result[0].content, str(session_id))
                self.message_store.list_messages.assert_called_with(session_id)
                self.session_store.get_session.assert_called_with(session_id)
        self.agent.get_state.assert_not_called()

    def test_missing_session_returns_404_without_reading_archive_or_checkpoint(self):
        self.session_store.get_session.return_value = None

        with self.assertRaises(HTTPException) as raised:
            chat_api.get_session_messages(chat_api.GetSessionByIdRequest(session_id=self.session_id))

        self.assertEqual(raised.exception.status_code, 404)
        self.message_store.list_messages.assert_not_called()
        self.agent.get_state.assert_not_called()

    def test_database_failures_are_safe_503_and_never_fall_back_to_checkpoint(self):
        for failing_call in [self.session_store.get_session, self.message_store.list_messages]:
            with self.subTest(failing_call=failing_call):
                failing_call.side_effect = RuntimeError("private database connection details")
                try:
                    with self.assertRaises(HTTPException) as raised:
                        chat_api.get_session_messages(
                            chat_api.GetSessionByIdRequest(session_id=self.session_id),
                        )
                    self.assertEqual(raised.exception.status_code, 503)
                    self.assertEqual(raised.exception.detail, "聊天档案暂时无法读取，请稍后重试")
                    self.assertNotIn("private database", raised.exception.detail)
                finally:
                    failing_call.side_effect = None
        self.agent.get_state.assert_not_called()


class ChatHttpTests(unittest.TestCase):
    session_id = "11111111-1111-4111-8111-111111111111"
    request_id = "22222222-2222-4222-8222-222222222222"

    def setUp(self):
        for name in ["agent", "session_store", "session_locks", "request_store", "message_store"]:
            patcher = patch.object(chat_api.app.state, name, Mock(), create=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(chat_api, "send_message", return_value="Hello")
        self.send_message = patcher.start()
        self.addCleanup(patcher.stop)
        # 不进入 lifespan，HTTP 契约测试不会创建真实数据库或模型资源。
        self.client = TestClient(chat_api.app)
        self.addCleanup(self.client.close)

    def test_chat_keeps_the_json_string_response_and_http_error_format(self):
        body = {"session_id": self.session_id, "content": "Hello"}
        response = self.client.post("/api/chat", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), "Hello")
        self.assertIsNone(self.send_message.call_args.kwargs["request_id"])
        self.assertIs(self.send_message.call_args.kwargs["request_store"], chat_api.app.state.request_store)
        self.assertIs(self.send_message.call_args.kwargs["message_store"], chat_api.app.state.message_store)

        self.send_message.side_effect = ChatError("SESSION_BUSY", "当前会话正在处理消息，请等待完成")
        response = self.client.post("/api/chat", json=body)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "当前会话正在处理消息，请等待完成"})

    def test_chat_accepts_request_id_and_still_returns_a_json_string(self):
        response = self.client.post("/api/chat", json={
            "session_id": self.session_id, "content": "Hello", "request_id": self.request_id,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), "Hello")
        self.assertEqual(self.send_message.call_args.kwargs["request_id"], UUID(self.request_id))

    def test_chat_context_errors_preserve_safe_messages_and_their_http_status(self):
        body = {"session_id": self.session_id, "request_id": self.request_id, "content": "Hello"}
        for code, status in [("CONTEXT_LIMIT_EXCEEDED", 413), ("CONTEXT_STATE_INVALID", 409)]:
            with self.subTest(code=code):
                self.send_message.side_effect = ChatError(code, "公开的上下文错误说明")

                response = self.client.post("/api/chat", json=body)

                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json(), {"detail": "公开的上下文错误说明"})

    def test_status_query_returns_a_saved_context_error_without_retrying_the_agent(self):
        session_store = chat_api.app.state.session_store
        request_store = chat_api.app.state.request_store
        session_store.get_session.return_value = {"id": UUID(self.session_id)}
        with patch("src.service.chat_service.invoke") as invoke:
            for code in ["CONTEXT_LIMIT_EXCEEDED", "CONTEXT_STATE_INVALID"]:
                with self.subTest(code=code):
                    record = saved_request(UUID(self.request_id), UUID(self.session_id), "failed")
                    record.update(error_code=code, error_message="已保存的上下文错误说明")
                    request_store.get_request.return_value = record

                    response = self.client.get(
                        f"/api/chat/requests/{self.request_id}", params={"session_id": self.session_id},
                    )

                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), {
                        "request_id": self.request_id,
                        "session_id": self.session_id,
                        "status": "failed",
                        "reply": None,
                        "error": {"code": code, "message": "已保存的上下文错误说明"},
                    })
            invoke.assert_not_called()
        self.send_message.assert_not_called()
        request_store.mark_failed.assert_not_called()
        request_store.mark_succeeded.assert_not_called()

    def test_invalid_http_input_never_reaches_the_service(self):
        for body in [
            {"session_id": self.session_id},
            {"content": "Hello"},
            {"session_id": "invalid-id", "content": "Hello"},
            {"session_id": self.session_id, "content": None},
            {"session_id": self.session_id, "content": 123},
            {"session_id": self.session_id, "content": "Hello", "request_id": "invalid-id"},
        ]:
            with self.subTest(body=body):
                response = self.client.post("/api/chat", json=body)
                self.assertEqual(response.status_code, 422)
                self.send_message.assert_not_called()

        response = self.client.post("/api/chat", json={
            "session_id": self.session_id, "content": "   ",
        })
        self.assertEqual(response.status_code, 400)
        self.send_message.assert_not_called()

    def test_status_get_returns_each_status_without_running_the_agent(self):
        session_store = chat_api.app.state.session_store
        request_store = chat_api.app.state.request_store
        session_store.get_session.return_value = {"id": UUID(self.session_id)}
        with patch("src.service.chat_service.invoke") as invoke:
            for status in ["processing", "succeeded", "failed"]:
                with self.subTest(status=status):
                    request_store.get_request.return_value = saved_request(
                        UUID(self.request_id), UUID(self.session_id), status,
                    )
                    response = self.client.get(
                        f"/api/chat/requests/{self.request_id}", params={"session_id": self.session_id},
                    )
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), {
                        "request_id": self.request_id,
                        "session_id": self.session_id,
                        "status": status,
                        "reply": "Saved reply" if status == "succeeded" else None,
                        "error": {"code": "MODEL_TIMEOUT", "message": "模型响应超时"}
                        if status == "failed" else None,
                    })
            invoke.assert_not_called()
        self.send_message.assert_not_called()
        request_store.try_start.assert_not_called()
        request_store.mark_succeeded.assert_not_called()
        request_store.mark_failed.assert_not_called()

    def test_status_get_hides_missing_and_other_sessions_requests(self):
        chat_api.app.state.session_store.get_session.return_value = {"id": UUID(self.session_id)}
        for record in [None, saved_request(UUID(self.request_id), UUID("33333333-3333-4333-8333-333333333333"))]:
            with self.subTest(record=record):
                chat_api.app.state.request_store.get_request.return_value = record
                response = self.client.get(
                    f"/api/chat/requests/{self.request_id}", params={"session_id": self.session_id},
                )
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"detail": "请求不存在"})
        self.send_message.assert_not_called()

    def test_status_get_database_error_is_safe_503(self):
        chat_api.app.state.session_store.get_session.return_value = {"id": UUID(self.session_id)}
        chat_api.app.state.request_store.get_request.side_effect = RuntimeError("private database details")
        with self.assertLogs("src.service.chat_service", level="ERROR"):
            response = self.client.get(
                f"/api/chat/requests/{self.request_id}", params={"session_id": self.session_id},
            )
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private database", response.text)
        self.send_message.assert_not_called()

    def test_status_get_rejects_invalid_or_missing_uuid_parameters(self):
        for path, params in [
            ("invalid-id", {"session_id": self.session_id}),
            (self.request_id, {"session_id": "invalid-id"}),
            (self.request_id, {}),
        ]:
            with self.subTest(path=path, params=params):
                response = self.client.get(f"/api/chat/requests/{path}", params=params)
                self.assertEqual(response.status_code, 422)
        chat_api.app.state.request_store.get_request.assert_not_called()
        self.send_message.assert_not_called()

    def test_history_http_reads_archive_without_exposing_internal_columns(self):
        chat_api.app.state.session_store.get_session.return_value = {"id": UUID(self.session_id)}
        chat_api.app.state.message_store.list_messages.return_value = [{
            "id": UUID("44444444-4444-4444-8444-444444444444"),
            "sequence": 10,
            "session_id": UUID(self.session_id),
            "request_id": UUID(self.request_id),
            "role": "assistant",
            "content": "从独立档案读取的回复",
            "created_at": "2026-11-09T12:00:00Z",
        }]
        chat_api.app.state.agent.get_state.side_effect = AssertionError("不能读取 Checkpoint")

        response = self.client.post("/api/sessions/getSessionMessages", json={"session_id": self.session_id})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [{
            "id": "44444444-4444-4444-8444-444444444444",
            "role": "assistant", "content": "从独立档案读取的回复",
        }])
        chat_api.app.state.message_store.list_messages.assert_called_once_with(UUID(self.session_id))
        chat_api.app.state.agent.get_state.assert_not_called()
        self.send_message.assert_not_called()

    def test_history_http_missing_session_and_database_failure_are_not_empty_history(self):
        session_store = chat_api.app.state.session_store
        message_store = chat_api.app.state.message_store
        session_store.get_session.return_value = None
        response = self.client.post("/api/sessions/getSessionMessages", json={"session_id": self.session_id})
        self.assertEqual(response.status_code, 404)
        message_store.list_messages.assert_not_called()

        session_store.get_session.return_value = {"id": UUID(self.session_id)}
        message_store.list_messages.side_effect = RuntimeError("private database connection details")
        response = self.client.post("/api/sessions/getSessionMessages", json={"session_id": self.session_id})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "聊天档案暂时无法读取，请稍后重试"})
        self.assertNotIn("private database", response.text)
        chat_api.app.state.agent.get_state.assert_not_called()
        self.send_message.assert_not_called()

    def test_history_http_rejects_invalid_session_before_reading_stores(self):
        response = self.client.post("/api/sessions/getSessionMessages", json={"session_id": "invalid-id"})

        self.assertEqual(response.status_code, 422)
        chat_api.app.state.session_store.get_session.assert_not_called()
        chat_api.app.state.message_store.list_messages.assert_not_called()

    def test_web_ui_uses_the_same_application_and_serves_the_page(self):
        from web_ui.main import app as ui_app

        self.assertIs(ui_app, chat_api.app)
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Teresa", response.text)
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
