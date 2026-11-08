import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import Mock, patch
from uuid import UUID

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from ollama import ResponseError

from src.common.agent_lock import SessionLocks
from src.domains.chat_domain import UserMessage
from src.router.web_server import app, chat, valid_chat_request


class ChatRequestTests(unittest.TestCase):
    session_id = "11111111-1111-4111-8111-111111111111"

    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.session_store = Mock()
        self.session_store.get_session.return_value = {"id": self.session_id}
        self.session_store.touch_session.return_value = True
        self.agent = object()
        self.session_locks = SessionLocks()
        for name, value in [
            ("session_store", self.session_store),
            ("agent", self.agent),
            ("session_locks", self.session_locks),
        ]:
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
        self.session_store.touch_session.assert_called_once_with(UUID(self.session_id))

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

    def test_invalid_content_is_rejected_even_if_the_session_is_busy_or_missing(self):
        self.session_store.get_session.return_value = None
        lock = self.session_locks.get(UUID(self.session_id))
        lock.acquire()
        try:
            response = self.client.post("/api/chat", json={
                "session_id": self.session_id,
                "content": "   ",
            })
        finally:
            lock.release()
        self.assertEqual(response.status_code, 400)
        self.session_store.get_session.assert_not_called()
        self.invoke.assert_not_called()

    def test_activity_update_failure_preserves_successful_reply_and_releases_lock(self):
        self.session_store.touch_session.side_effect = RuntimeError("private connection details")
        with self.assertLogs("src.router.web_server", level="ERROR") as logs:
            response = self.client.post("/api/chat", json={
                "session_id": self.session_id,
                "content": "Hello",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), "Hello")
        self.invoke.assert_called_once()
        self.assertIn("session_touch_failed", " ".join(logs.output))
        self.assertNotIn("private connection details", " ".join(logs.output))
        lock = self.session_locks.get(UUID(self.session_id))
        self.assertTrue(lock.acquire(blocking=False))
        lock.release()

    def test_missing_activity_update_row_does_not_discard_successful_reply(self):
        self.session_store.touch_session.return_value = False
        with self.assertLogs("src.router.web_server", level="WARNING"):
            response = self.client.post("/api/chat", json={
                "session_id": self.session_id,
                "content": "Hello",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), "Hello")

    def test_agent_failures_map_to_http_errors_without_updating_activity(self):
        for error, status in [
            (httpx.ReadTimeout("private upstream details"), 504),
            (httpx.ConnectError("private upstream details"), 503),
            (ConnectionError("private upstream details"), 503),
            (ResponseError("private upstream details", status_code=500), 502),
            (RuntimeError("private upstream details"), 500),
        ]:
            with self.subTest(error=type(error).__name__):
                self.invoke.side_effect = error
                with patch("src.router.web_server.logger"):
                    response = self.client.post("/api/chat", json={
                        "session_id": self.session_id,
                        "content": "Hello",
                    })
                self.assertEqual(response.status_code, status)
                self.assertNotIn("private upstream details", response.text)
                self.session_store.touch_session.assert_not_called()
                lock = self.session_locks.get(UUID(self.session_id))
                self.assertTrue(lock.acquire(blocking=False))
                lock.release()

    def test_concurrent_request_for_the_same_session_is_rejected(self):
        entered = Event()
        finish = Event()

        def slow_invoke(**kwargs):
            entered.set()
            if not finish.wait(timeout=5):
                raise AssertionError("Test did not release the running request")
            return "Hello"

        self.invoke.side_effect = slow_invoke
        request = UserMessage(session_id=self.session_id, content="Hello")
        with ThreadPoolExecutor(max_workers=1) as executor:
            running = executor.submit(chat, request)
            try:
                self.assertTrue(entered.wait(timeout=5))
                with self.assertRaises(HTTPException) as raised:
                    chat(request)
                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual(self.invoke.call_count, 1)
            finally:
                finish.set()
            self.assertEqual(running.result(timeout=5), "Hello")

    def test_different_sessions_can_execute_concurrently(self):
        both_entered = Barrier(2)

        def concurrent_invoke(**kwargs):
            both_entered.wait(timeout=5)
            return "Hello"

        self.invoke.side_effect = concurrent_invoke
        self.session_store.get_session.side_effect = lambda session_id: {"id": session_id}
        requests = [
            UserMessage(session_id=self.session_id, content="Hello"),
            UserMessage(session_id="22222222-2222-4222-8222-222222222222", content="Hello"),
        ]
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = [executor.submit(chat, request) for request in requests]
            self.assertEqual([result.result(timeout=6) for result in results], ["Hello", "Hello"])

    def test_web_ui_imports_the_moved_application_and_serves_the_page(self):
        from web_ui.main import app as ui_app

        self.assertIs(ui_app, app)
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Teresa", response.text)
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
