import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import Mock, patch
from uuid import UUID

import httpx
from ollama import ResponseError

from src.common.agent_lock import SessionLocks
from src.common.db.request_store import RequestStore
from src.domains.error_domain import ChatError
from src.service import chat_service


class ChatServiceTests(unittest.TestCase):
    session_id = UUID("11111111-1111-4111-8111-111111111111")
    request_id = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

    def setUp(self):
        self.session_store = Mock()
        self.session_store.get_session.return_value = {"id": self.session_id}
        self.session_store.touch_session.return_value = True
        self.agent = Mock()
        self.session_locks = SessionLocks()
        self.request_store = Mock(spec=RequestStore)
        self.request_store.get_request.return_value = None
        self.request_store.try_start.return_value = {"request_id": self.request_id}
        self.request_store.mark_succeeded.return_value = True
        self.request_store.mark_failed.return_value = True
        patcher = patch.object(chat_service, "invoke", return_value="Hello")
        self.invoke = patcher.start()
        self.addCleanup(patcher.stop)

    def send_message(self, content="Hello", session_id=None, request_id=None):
        return chat_service.send_message(
            session_id if session_id is not None else self.session_id,
            content,
            agent=self.agent,
            session_store=self.session_store,
            session_locks=self.session_locks,
            request_store=self.request_store,
            request_id=request_id,
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
        self.assertEqual(self.request_store.mock_calls, [])
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
                self.assertEqual(self.request_store.mock_calls, [])
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

    def saved_request(self, status="succeeded", **changes):
        return {
            "request_id": self.request_id,
            "session_id": self.session_id,
            "content": "Hello",
            "status": status,
            "reply": "Saved reply" if status == "succeeded" else None,
            "error_code": "MODEL_TIMEOUT" if status == "failed" else None,
            "error_message": "模型响应超时，请稍后查询历史确认结果" if status == "failed" else None,
            **changes,
        }

    def test_new_request_is_claimed_before_invoke_and_saved_before_activity_update(self):
        events = []
        content = "  Hello!\n你好  "

        def claim(**kwargs):
            events.append("claim")
            return {"request_id": self.request_id}

        def invoke(**kwargs):
            events.append("invoke")
            return "Fresh reply"

        def succeed(request_id, reply):
            events.append("succeeded")
            return True

        def touch(session_id):
            events.append("touch")
            return True

        self.request_store.try_start.side_effect = claim
        self.invoke.side_effect = invoke
        self.request_store.mark_succeeded.side_effect = succeed
        self.session_store.touch_session.side_effect = touch

        self.assertEqual(self.send_message(content, request_id=self.request_id), "Fresh reply")

        self.assertEqual(events, ["claim", "invoke", "succeeded", "touch"])
        self.request_store.get_request.assert_called_once_with(self.request_id)
        self.request_store.try_start.assert_called_once_with(
            request_id=self.request_id, session_id=self.session_id, content=content
        )
        self.invoke.assert_called_once_with(
            user_message={"role": "user", "content": content},
            agent=self.agent,
            session_id=self.session_id,
        )
        self.request_store.mark_succeeded.assert_called_once_with(self.request_id, "Fresh reply")
        self.request_store.mark_failed.assert_not_called()
        self.assert_session_lock_released()

    def test_cached_success_is_returned_even_when_the_session_is_busy(self):
        self.request_store.get_request.return_value = self.saved_request()
        lock = self.session_locks.get(self.session_id)
        lock.acquire()
        try:
            self.assertEqual(self.send_message(request_id=self.request_id), "Saved reply")
            self.assertTrue(lock.locked())
        finally:
            lock.release()

        self.invoke.assert_not_called()
        self.request_store.try_start.assert_not_called()
        self.request_store.mark_succeeded.assert_not_called()
        self.request_store.mark_failed.assert_not_called()
        self.session_store.touch_session.assert_not_called()

    def test_same_request_id_with_different_session_or_content_is_rejected(self):
        conflicting_records = [
            self.saved_request(session_id=UUID("22222222-2222-4222-8222-222222222222")),
            self.saved_request(content="Hello "),
            self.saved_request("processing", content="A different question"),
        ]
        for record in conflicting_records:
            with self.subTest(record=record):
                self.request_store.get_request.return_value = record
                with self.assertRaises(ChatError) as raised:
                    self.send_message(request_id=self.request_id)
                self.assertEqual(raised.exception.code, "REQUEST_ID_CONFLICT")

        self.invoke.assert_not_called()
        self.request_store.try_start.assert_not_called()
        self.request_store.mark_succeeded.assert_not_called()
        self.request_store.mark_failed.assert_not_called()

    def test_saved_processing_or_failed_request_is_not_executed_again(self):
        for status, code in [("processing", "REQUEST_PROCESSING"), ("failed", "MODEL_TIMEOUT")]:
            with self.subTest(status=status):
                record = self.saved_request(status)
                self.request_store.get_request.return_value = record
                with self.assertRaises(ChatError) as raised:
                    self.send_message(request_id=self.request_id)
                self.assertEqual(raised.exception.code, code)
                if status == "failed":
                    self.assertEqual(raised.exception.message, record["error_message"])

        self.invoke.assert_not_called()
        self.request_store.try_start.assert_not_called()
        self.request_store.mark_succeeded.assert_not_called()
        self.request_store.mark_failed.assert_not_called()
        self.session_store.touch_session.assert_not_called()

    def test_unknown_saved_status_never_restarts_the_request(self):
        self.request_store.get_request.return_value = self.saved_request("unexpected")
        with self.assertRaises(ChatError) as raised:
            self.send_message(request_id=self.request_id)
        self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
        self.invoke.assert_not_called()
        self.request_store.try_start.assert_not_called()

    def test_losing_the_atomic_claim_uses_the_winners_record_without_invoking(self):
        for status, code in [("succeeded", None), ("processing", "REQUEST_PROCESSING"), ("failed", "MODEL_TIMEOUT")]:
            with self.subTest(status=status):
                self.request_store.get_request.side_effect = [None, self.saved_request(status)]
                self.request_store.try_start.return_value = None
                if code is None:
                    self.assertEqual(self.send_message(request_id=self.request_id), "Saved reply")
                else:
                    with self.assertRaises(ChatError) as raised:
                        self.send_message(request_id=self.request_id)
                    self.assertEqual(raised.exception.code, code)
                self.assert_session_lock_released()

        self.invoke.assert_not_called()
        self.request_store.mark_succeeded.assert_not_called()
        self.request_store.mark_failed.assert_not_called()
        self.session_store.touch_session.assert_not_called()

    def test_losing_the_claim_still_checks_the_winners_payload(self):
        self.request_store.get_request.side_effect = [None, self.saved_request(content="Different")]
        self.request_store.try_start.return_value = None
        with self.assertRaises(ChatError) as raised:
            self.send_message(request_id=self.request_id)
        self.assertEqual(raised.exception.code, "REQUEST_ID_CONFLICT")
        self.invoke.assert_not_called()
        self.assert_session_lock_released()

    def test_losing_the_claim_without_a_readable_record_is_unknown(self):
        self.request_store.try_start.return_value = None
        with self.assertRaises(ChatError) as raised:
            self.send_message(request_id=self.request_id)
        self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
        self.assertEqual(self.request_store.get_request.call_count, 2)
        self.invoke.assert_not_called()
        self.assert_session_lock_released()

    def test_request_read_or_claim_errors_do_not_start_the_model(self):
        for failing_method in ["get_request", "try_start", "read_after_claim"]:
            with self.subTest(method=failing_method):
                self.request_store.reset_mock(side_effect=True)
                self.request_store.get_request.return_value = None
                self.request_store.try_start.return_value = {"request_id": self.request_id}
                error = RuntimeError("private database details")
                if failing_method == "read_after_claim":
                    self.request_store.try_start.return_value = None
                    self.request_store.get_request.side_effect = [None, error]
                else:
                    getattr(self.request_store, failing_method).side_effect = error
                with patch.object(chat_service, "logger"):
                    with self.assertRaises(ChatError) as raised:
                        self.send_message(request_id=self.request_id)
                self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
                self.assertNotIn("private database details", str(raised.exception))
                self.invoke.assert_not_called()
                self.request_store.mark_succeeded.assert_not_called()
                self.request_store.mark_failed.assert_not_called()
                self.session_store.touch_session.assert_not_called()
                self.assert_session_lock_released()

    def test_model_errors_with_an_id_are_saved_then_propagated_without_touching_activity(self):
        failures = [
            (httpx.ReadTimeout("private upstream details"), "MODEL_TIMEOUT"),
            (httpx.ConnectError("private upstream details"), "MODEL_UNAVAILABLE"),
            (ConnectionError("private upstream details"), "MODEL_UNAVAILABLE"),
            (ResponseError("private upstream details", status_code=500), "MODEL_RESPONSE_ERROR"),
            (RuntimeError("private upstream details"), "CHAT_FAILED"),
        ]
        for error, code in failures:
            with self.subTest(error=type(error).__name__):
                self.request_store.mark_failed.reset_mock()
                self.invoke.side_effect = error
                with patch.object(chat_service, "logger"):
                    with self.assertRaises(ChatError) as raised:
                        self.send_message(request_id=self.request_id)
                self.assertEqual(raised.exception.code, code)
                self.request_store.mark_failed.assert_called_once_with(
                    self.request_id, code, raised.exception.message
                )
                self.assertNotIn("private upstream details", raised.exception.message)
                self.request_store.mark_succeeded.assert_not_called()
                self.session_store.touch_session.assert_not_called()
                self.assert_session_lock_released()

    def test_success_save_false_or_exception_is_unknown_and_does_not_return_success(self):
        for result in [False, RuntimeError("private database details")]:
            with self.subTest(result=result):
                self.invoke.reset_mock()
                self.request_store.get_request.reset_mock()
                self.request_store.mark_succeeded.reset_mock(side_effect=True)
                if isinstance(result, Exception):
                    self.request_store.mark_succeeded.side_effect = result
                else:
                    self.request_store.mark_succeeded.return_value = result
                with patch.object(chat_service, "logger"):
                    with self.assertRaises(ChatError) as raised:
                        self.send_message(request_id=self.request_id)
                self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
                self.assertNotIn("private database details", str(raised.exception))
                self.invoke.assert_called_once()
                self.assertEqual(self.request_store.get_request.call_count, 1)
                self.request_store.mark_failed.assert_not_called()
                self.session_store.touch_session.assert_not_called()
                self.assert_session_lock_released()

    def test_failure_save_false_or_exception_is_unknown_without_retrying_the_model(self):
        self.invoke.side_effect = httpx.ReadTimeout("private upstream details")
        for result in [False, RuntimeError("private database details")]:
            with self.subTest(result=result):
                self.invoke.reset_mock()
                self.request_store.get_request.reset_mock()
                self.request_store.mark_failed.reset_mock(side_effect=True)
                if isinstance(result, Exception):
                    self.request_store.mark_failed.side_effect = result
                else:
                    self.request_store.mark_failed.return_value = result
                with patch.object(chat_service, "logger"):
                    with self.assertRaises(ChatError) as raised:
                        self.send_message(request_id=self.request_id)
                self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
                self.assertNotIn("private database details", str(raised.exception))
                self.invoke.assert_called_once()
                self.assertEqual(self.request_store.get_request.call_count, 1)
                self.request_store.mark_succeeded.assert_not_called()
                self.session_store.touch_session.assert_not_called()
                self.assert_session_lock_released()

    def test_saved_success_is_kept_when_activity_update_fails(self):
        self.session_store.touch_session.side_effect = RuntimeError("private database details")
        with self.assertLogs("src.service.chat_service", level="ERROR"):
            self.assertEqual(self.send_message(request_id=self.request_id), "Hello")
        self.request_store.mark_succeeded.assert_called_once_with(self.request_id, "Hello")
        self.request_store.mark_failed.assert_not_called()
        self.assert_session_lock_released()

    def test_request_status_query_returns_the_saved_record_without_invoking(self):
        for status in ["processing", "succeeded", "failed"]:
            with self.subTest(status=status):
                record = self.saved_request(status)
                self.request_store.get_request.return_value = record
                result = chat_service.get_request_status(
                    self.session_id, self.request_id,
                    session_store=self.session_store, request_store=self.request_store,
                )
                self.assertEqual(result, record)
        self.invoke.assert_not_called()
        self.request_store.try_start.assert_not_called()
        self.request_store.mark_succeeded.assert_not_called()
        self.request_store.mark_failed.assert_not_called()

    def test_request_status_query_checks_the_session_first(self):
        self.session_store.get_session.return_value = None
        with self.assertRaises(ChatError) as raised:
            chat_service.get_request_status(
                self.session_id, self.request_id,
                session_store=self.session_store, request_store=self.request_store,
            )
        self.assertEqual(raised.exception.code, "SESSION_NOT_FOUND")
        self.request_store.get_request.assert_not_called()
        self.invoke.assert_not_called()

    def test_request_status_session_lookup_error_is_unknown_and_does_not_read_the_request(self):
        self.session_store.get_session.side_effect = RuntimeError("private session database details")
        with patch.object(chat_service, "logger"):
            with self.assertRaises(ChatError) as raised:
                chat_service.get_request_status(
                    self.session_id, self.request_id,
                    session_store=self.session_store, request_store=self.request_store,
                )
        self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
        self.assertNotIn("private session database details", raised.exception.message)
        self.request_store.get_request.assert_not_called()
        self.invoke.assert_not_called()

    def test_request_status_query_hides_missing_or_other_sessions_records(self):
        for record in [None, self.saved_request(session_id=UUID("22222222-2222-4222-8222-222222222222"))]:
            with self.subTest(record=record):
                self.request_store.get_request.return_value = record
                with self.assertRaises(ChatError) as raised:
                    chat_service.get_request_status(
                        self.session_id, self.request_id,
                        session_store=self.session_store, request_store=self.request_store,
                    )
                self.assertEqual(raised.exception.code, "REQUEST_NOT_FOUND")
                self.assertNotIn("Saved reply", raised.exception.message)
        self.invoke.assert_not_called()

    def test_request_status_database_error_is_unknown(self):
        self.request_store.get_request.side_effect = RuntimeError("private database details")
        with patch.object(chat_service, "logger"):
            with self.assertRaises(ChatError) as raised:
                chat_service.get_request_status(
                    self.session_id, self.request_id,
                    session_store=self.session_store, request_store=self.request_store,
                )
        self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
        self.assertNotIn("private database details", raised.exception.message)
        self.invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main()
