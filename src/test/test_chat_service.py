import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import Mock, patch
from uuid import UUID

import httpx
from ollama import ResponseError

from src.common.agent_lock import SessionLocks
from src.domains.error_domain import ChatError
from src.service import chat_service


class ChatServiceTests(unittest.TestCase):
    session_id = UUID("11111111-1111-4111-8111-111111111111")

    def setUp(self):
        self.session_store = Mock()
        self.session_store.get_session.return_value = {"id": self.session_id}
        self.session_store.touch_session.return_value = True
        self.agent = Mock()
        self.session_locks = SessionLocks()
        patcher = patch.object(chat_service, "invoke", return_value="Hello")
        self.invoke = patcher.start()
        self.addCleanup(patcher.stop)

    def send_message(self, content="Hello", session_id=None):
        return chat_service.send_message(
            session_id if session_id is not None else self.session_id,
            content,
            agent=self.agent,
            session_store=self.session_store,
            session_locks=self.session_locks,
        )

    def assert_session_lock_released(self, session_id=None):
        lock = self.session_locks.get(
            session_id if session_id is not None else self.session_id
        )
        acquired = lock.acquire(blocking=False)
        self.assertTrue(acquired)
        if acquired:
            lock.release()

    def test_content_and_session_id_are_forwarded_without_changing_the_original_text(self):
        content = "  你好，Teresa!\nLet's practise English.  "

        self.assertEqual(self.send_message(content), "Hello")

        self.session_store.get_session.assert_called_once_with(self.session_id)
        self.invoke.assert_called_once_with(
            user_message={"role": "user", "content": content},
            agent=self.agent,
            session_id=self.session_id,
        )
        self.session_store.touch_session.assert_called_once_with(self.session_id)
        self.assert_session_lock_released()

    def test_missing_session_does_not_invoke_the_agent_or_update_activity(self):
        self.session_store.get_session.return_value = None

        with self.assertRaises(ChatError) as raised:
            self.send_message()

        self.assertEqual(raised.exception.code, "SESSION_NOT_FOUND")
        self.assertEqual(raised.exception.message, "会话不存在")
        self.invoke.assert_not_called()
        self.session_store.touch_session.assert_not_called()

    def test_busy_session_does_not_release_another_requests_lock(self):
        lock = self.session_locks.get(self.session_id)
        lock.acquire()
        try:
            with self.assertRaises(ChatError) as raised:
                self.send_message()

            self.assertEqual(raised.exception.code, "SESSION_BUSY")
            self.assertEqual(
                raised.exception.message, "当前会话正在处理消息，请等待完成"
            )
            self.assertTrue(lock.locked())
            self.invoke.assert_not_called()
            self.session_store.touch_session.assert_not_called()
        finally:
            lock.release()

    def test_model_failures_are_safe_business_errors_and_release_the_session_lock(self):
        failures = [
            (
                httpx.ReadTimeout("private upstream details"),
                "MODEL_TIMEOUT",
                "模型响应超时，请稍后查询历史确认结果",
            ),
            (
                httpx.ConnectError("private upstream details"),
                "MODEL_UNAVAILABLE",
                "暂时无法连接模型服务",
            ),
            (
                ConnectionError("private upstream details"),
                "MODEL_UNAVAILABLE",
                "暂时无法连接模型服务",
            ),
            (
                ResponseError("private upstream details", status_code=500),
                "MODEL_RESPONSE_ERROR",
                "模型服务返回异常",
            ),
            (
                RuntimeError("private upstream details"),
                "CHAT_FAILED",
                "聊天处理失败，请稍后查询历史确认结果",
            ),
        ]
        for error, code, message in failures:
            with self.subTest(error=type(error).__name__):
                self.invoke.side_effect = error
                with patch.object(chat_service, "logger"):
                    with self.assertRaises(ChatError) as raised:
                        self.send_message()

                self.assertEqual(raised.exception.code, code)
                self.assertEqual(raised.exception.message, message)
                self.assertNotIn("private upstream details", str(raised.exception))
                self.session_store.touch_session.assert_not_called()
                self.assert_session_lock_released()

    def test_activity_update_failure_preserves_successful_reply_and_releases_lock(self):
        self.session_store.touch_session.side_effect = RuntimeError(
            "private connection details"
        )

        with self.assertLogs("src.service.chat_service", level="ERROR") as logs:
            reply = self.send_message()

        self.assertEqual(reply, "Hello")
        self.invoke.assert_called_once()
        self.assertIn("session_touch_failed", " ".join(logs.output))
        self.assertNotIn("private connection details", " ".join(logs.output))
        self.assert_session_lock_released()

    def test_missing_activity_update_row_does_not_discard_successful_reply(self):
        self.session_store.touch_session.return_value = False

        with self.assertLogs("src.service.chat_service", level="WARNING") as logs:
            reply = self.send_message()

        self.assertEqual(reply, "Hello")
        self.assertIn("session_touch_missing", " ".join(logs.output))
        self.assert_session_lock_released()

    def test_concurrent_request_for_the_same_session_is_rejected(self):
        entered = Event()
        finish = Event()

        def slow_invoke(**kwargs):
            entered.set()
            if not finish.wait(timeout=5):
                raise AssertionError("Test did not release the running request")
            return "Hello"

        self.invoke.side_effect = slow_invoke
        with ThreadPoolExecutor(max_workers=1) as executor:
            running = executor.submit(self.send_message)
            try:
                self.assertTrue(entered.wait(timeout=5))
                with self.assertRaises(ChatError) as raised:
                    self.send_message()
                self.assertEqual(raised.exception.code, "SESSION_BUSY")
                self.assertEqual(self.invoke.call_count, 1)
            finally:
                finish.set()
            self.assertEqual(running.result(timeout=5), "Hello")

        self.session_store.touch_session.assert_called_once_with(self.session_id)
        self.assert_session_lock_released()

    def test_different_sessions_can_execute_concurrently(self):
        both_entered = Barrier(2)
        session_ids = [
            self.session_id,
            UUID("22222222-2222-4222-8222-222222222222"),
        ]

        def concurrent_invoke(**kwargs):
            both_entered.wait(timeout=5)
            return f"Reply for {kwargs['session_id']}"

        self.invoke.side_effect = concurrent_invoke
        self.session_store.get_session.side_effect = lambda session_id: {
            "id": session_id
        }
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = [
                executor.submit(self.send_message, "Hello", session_id)
                for session_id in session_ids
            ]
            self.assertEqual(
                [result.result(timeout=6) for result in results],
                [f"Reply for {session_id}" for session_id in session_ids],
            )

        self.assertEqual(self.invoke.call_count, 2)
        self.assertEqual(self.session_store.touch_session.call_count, 2)
        for session_id in session_ids:
            self.session_store.touch_session.assert_any_call(session_id)
            self.assert_session_lock_released(session_id)


if __name__ == "__main__":
    unittest.main()
