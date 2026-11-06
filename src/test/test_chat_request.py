import unittest
from unittest.mock import Mock, patch
from uuid import UUID

from fastapi.testclient import TestClient

from src.domains.chat_domain import UserMessage
from src.router.web_server import app, valid_chat_request


class ChatRequestTests(unittest.TestCase):
    session_id = "11111111-1111-4111-8111-111111111111"

    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.session_store = Mock()
        self.session_store.get_session.return_value = {"id": self.session_id}
        self.agent = object()
        for name, value in [("session_store", self.session_store), ("agent", self.agent)]:
            patcher = patch.object(app.state, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.invoke_patcher = patch("src.router.web_server.invoke", return_value="Hello")
        self.invoke = self.invoke_patcher.start()
        self.addCleanup(self.invoke_patcher.stop)

    def test_empty_whitespace_and_oversized_content_are_rejected_before_business_calls(self):
        for content in ["", " \t\r\n ", "a" * 12001]:
            with self.subTest(length=len(content)):
                response = self.client.post("/api/chat", json={
                    "session_id": self.session_id,
                    "content": content,
                })
                self.assertEqual(response.status_code, 400)
                self.session_store.get_session.assert_not_called()
                self.invoke.assert_not_called()

    def test_invalid_request_shape_is_rejected_by_pydantic(self):
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
                self.session_store.get_session.assert_not_called()
                self.invoke.assert_not_called()

    def test_valid_content_is_forwarded_unchanged_with_the_session_id(self):
        content = "  你好，Teresa!\nLet's practise English.  "
        response = self.client.post("/api/chat", json={
            "session_id": self.session_id,
            "content": content,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), "Hello")
        self.session_store.get_session.assert_called_once_with(UUID(self.session_id))
        self.invoke.assert_called_once_with(
            user_message={"role": "user", "content": content},
            agent=self.agent,
            session_id=UUID(self.session_id),
        )

    def test_content_at_the_length_limit_is_accepted(self):
        response = self.client.post("/api/chat", json={
            "session_id": self.session_id,
            "content": "a" * 12000,
        })
        self.assertEqual(response.status_code, 200)
        self.invoke.assert_called_once()

    def test_missing_session_returns_404_without_calling_agent(self):
        self.session_store.get_session.return_value = None
        response = self.client.post("/api/chat", json={
            "session_id": self.session_id,
            "content": "Hello",
        })
        self.assertEqual(response.status_code, 404)
        self.invoke.assert_not_called()

    def test_helper_rejects_a_truthy_invalid_id_when_model_validation_is_bypassed(self):
        request = UserMessage.model_construct(content="Hello", session_id="invalid-id")
        self.assertFalse(valid_chat_request(request))

    def test_web_ui_imports_the_moved_application_and_serves_the_page(self):
        from web_ui.main import app as ui_app

        self.assertIs(ui_app, app)
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Teresa", response.text)
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
