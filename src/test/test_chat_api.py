import unittest
from unittest.mock import Mock, patch
from uuid import UUID

from fastapi import HTTPException
from fastapi.testclient import TestClient

from src.domains.chat_domain import UserMessage
from src.domains.error_domain import ChatError
from src.router import chat_api


class ChatApiTests(unittest.TestCase):
    session_id = UUID("11111111-1111-4111-8111-111111111111")

    def setUp(self):
        self.agent = Mock()
        self.session_store = Mock()
        self.session_locks = Mock()
        for name, value in [
            ("agent", self.agent),
            ("session_store", self.session_store),
            ("session_locks", self.session_locks),
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
        )

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
        ]:
            with self.subTest(code=code):
                self.send_message.side_effect = ChatError(code, "公开错误说明")
                with self.assertRaises(HTTPException) as raised:
                    chat_api.chat(UserMessage(session_id=self.session_id, content="Hello"))
                self.assertEqual(raised.exception.status_code, status)
                self.assertEqual(raised.exception.detail, "公开错误说明")


class ChatHttpTests(unittest.TestCase):
    session_id = "11111111-1111-4111-8111-111111111111"

    def setUp(self):
        for name in ["agent", "session_store", "session_locks"]:
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

        self.send_message.side_effect = ChatError("SESSION_BUSY", "当前会话正在处理消息，请等待完成")
        response = self.client.post("/api/chat", json=body)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "当前会话正在处理消息，请等待完成"})

    def test_invalid_http_input_never_reaches_the_service(self):
        for body in [
            {"session_id": self.session_id},
            {"content": "Hello"},
            {"session_id": "invalid-id", "content": "Hello"},
            {"session_id": self.session_id, "content": None},
            {"session_id": self.session_id, "content": 123},
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

    def test_web_ui_uses_the_same_application_and_serves_the_page(self):
        from web_ui.main import app as ui_app

        self.assertIs(ui_app, chat_api.app)
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Teresa", response.text)
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
