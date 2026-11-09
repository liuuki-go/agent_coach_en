"""可选真实数据库验证：每项测试的临时 schema 和数据全部在外层事务回滚。

仅在 CHAT_TEST_POSTGRES=1 时连接项目配置的 PostgreSQL，不调用 Ollama。
"""

import os
import unittest
from contextlib import contextmanager
from unittest.mock import Mock, patch
from uuid import uuid4

from psycopg import sql
from psycopg.errors import CheckViolation, UniqueViolation

from src.common.agent_lock import SessionLocks
from src.common.dababase_pool import create_db_pool
from src.common.db.message_store import MessageStore
from src.common.db.request_store import RequestStore
from src.common.db.session_store import SessionStore
from src.domains.error_domain import ChatError
from src.service import chat_service


class _BoundPool:
    """让真实 Store 共用测试连接，所有写入都留在可回滚的隔离 schema 中。"""

    def __init__(self, connection):
        self.bound_connection = connection

    @contextmanager
    def connection(self):
        yield self.bound_connection


@unittest.skipUnless(os.environ.get("CHAT_TEST_POSTGRES") == "1", "需要显式启用 PostgreSQL 集成测试")
class MessageStorePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pool = create_db_pool()
        try:
            cls.pool.open(wait=True, timeout=5)
        except Exception:
            cls.pool.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.pool.close()

    def setUp(self):
        connection_context = self.pool.connection()
        self.connection = connection_context.__enter__()
        self.addCleanup(connection_context.__exit__, None, None, None)
        self.schema = "test_chat_messages_" + uuid4().hex
        self.addCleanup(self.assert_schema_rolled_back)
        transaction = self.connection.transaction(force_rollback=True)
        transaction.__enter__()
        self.addCleanup(transaction.__exit__, None, None, None)
        self.connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.connection.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(self.schema)))
        bound_pool = _BoundPool(self.connection)
        self.sessions = SessionStore(bound_pool)
        self.requests = RequestStore(bound_pool)
        self.messages = MessageStore(bound_pool)
        self.sessions.setup()
        self.requests.setup()
        self.messages.setup()
        self.session_id = self.sessions.create_session()["id"]
        self.request_id = uuid4()
        self.locks = SessionLocks()

    def assert_schema_rolled_back(self):
        row = self.connection.execute("SELECT to_regnamespace(%s) AS name", (self.schema,)).fetchone()
        self.assertIsNone(row["name"], "隔离测试 schema 应随外层事务回滚")

    def send(self, request_id, content="  原始问题; It's a question.  "):
        return chat_service.send_message(
            self.session_id, content, agent=Mock(), session_store=self.sessions,
            session_locks=self.locks, request_store=self.requests,
            message_store=self.messages, request_id=request_id,
        )

    def test_success_and_replay_preserve_one_message_pair_and_the_same_result(self):
        reply = "  真实保存的回复。  "
        with patch.object(chat_service, "invoke", return_value=reply) as invoke:
            self.assertEqual(self.send(self.request_id), reply)
            original = self.messages.list_messages(self.session_id)
            self.assertEqual(self.send(self.request_id), reply)
            invoke.assert_called_once()

        self.assertEqual(self.messages.list_messages(self.session_id), original)
        self.assertEqual([row["role"] for row in original], ["user", "assistant"])
        self.assertEqual(original[0]["content"], "  原始问题; It's a question.  ")
        self.assertEqual(original[1]["content"], reply)
        self.assertNotEqual(original[0]["id"], original[1]["id"])
        self.assertLess(original[0]["sequence"], original[1]["sequence"])
        self.assertTrue(all(row["request_id"] == self.request_id for row in original))
        saved = self.requests.get_request(self.request_id)
        self.assertEqual((saved["status"], saved["reply"]), ("succeeded", reply))

    def test_model_failure_keeps_failed_request_without_a_successful_archive(self):
        with patch.object(chat_service, "invoke", side_effect=ConnectionError("private upstream")):
            with self.assertRaises(ChatError) as raised:
                self.send(self.request_id)
        self.assertEqual(raised.exception.code, "MODEL_UNAVAILABLE")
        self.assertEqual(self.requests.get_request(self.request_id)["status"], "failed")
        self.assertEqual(self.messages.list_messages(self.session_id), [])

    def test_request_update_error_rolls_back_both_messages_and_the_updated_status(self):
        original_update = self.requests.mark_succeeded

        def update_then_fail(*args, **kwargs):
            self.assertTrue(original_update(*args, **kwargs))
            self.assertEqual(len(self.messages.list_messages(self.session_id)), 2)
            raise RuntimeError("Failure after all three business writes")

        with patch.object(chat_service, "invoke", return_value="Reply"), \
                patch.object(self.requests, "mark_succeeded", side_effect=update_then_fail), \
                patch.object(chat_service, "logger"):
            with self.assertRaises(ChatError) as raised:
                self.send(self.request_id)
        self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
        self.assertEqual(self.messages.list_messages(self.session_id), [])
        saved = self.requests.get_request(self.request_id)
        self.assertEqual(saved["status"], "processing")
        self.assertIsNone(saved["reply"])

    def test_zero_row_terminal_update_also_rolls_back_the_inserted_pair(self):
        with patch.object(chat_service, "invoke", return_value="Reply"), \
                patch.object(self.requests, "mark_succeeded", return_value=False), \
                patch.object(chat_service, "logger"):
            with self.assertRaises(ChatError) as raised:
                self.send(self.request_id)
        self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
        self.assertEqual(self.messages.list_messages(self.session_id), [])
        self.assertEqual(self.requests.get_request(self.request_id)["status"], "processing")

    def test_archive_constraint_failure_leaves_no_half_pair_or_success_status(self):
        self.connection.execute("ALTER TABLE chat_messages ADD CHECK (role <> 'assistant')")
        with patch.object(chat_service, "invoke", return_value="Reply"), \
                patch.object(chat_service, "logger"):
            with self.assertRaises(ChatError) as raised:
                self.send(self.request_id)
        self.assertEqual(raised.exception.code, "REQUEST_STATE_UNKNOWN")
        self.assertEqual(self.messages.list_messages(self.session_id), [])
        self.assertEqual(self.requests.get_request(self.request_id)["status"], "processing")

    def test_database_prevents_duplicate_roles_and_invalid_messages(self):
        with patch.object(chat_service, "invoke", return_value="Reply"):
            self.send(self.request_id)
        with self.assertRaises(UniqueViolation):
            with self.connection.transaction():
                self.messages.add_exchange(self.connection, self.session_id, self.request_id, "Hello", "Reply")
        with self.assertRaises(CheckViolation):
            with self.connection.transaction():
                self.messages.add_exchange(self.connection, self.session_id, None, "Hello", "   ")
        self.assertEqual(len(self.messages.list_messages(self.session_id)), 2)

    def test_legacy_requests_archive_without_request_rows_and_sessions_stay_separate(self):
        other_session = self.sessions.create_session()["id"]
        with patch.object(chat_service, "invoke", return_value="Reply"):
            self.send(None)
            self.send(None)
        rows = self.messages.list_messages(self.session_id)
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(row["request_id"] is None for row in rows))
        self.assertEqual(self.messages.list_messages(other_session), [])
        count = self.connection.execute("SELECT count(*) AS count FROM chat_requests").fetchone()["count"]
        self.assertEqual(count, 0)

    def test_setup_backfills_only_successes_and_does_not_duplicate_or_rewrite_archive(self):
        succeeded_id, failed_id, pending_id = uuid4(), uuid4(), uuid4()
        self.requests.try_start(succeeded_id, self.session_id, "  Old question  ")
        self.requests.mark_succeeded(succeeded_id, "  Old answer  ")
        self.requests.try_start(failed_id, self.session_id, "Failed question")
        self.requests.mark_failed(failed_id, "MODEL_TIMEOUT", "超时")
        self.requests.try_start(pending_id, self.session_id, "Pending question")
        self.messages.setup()
        original = self.messages.list_messages(self.session_id)
        self.messages.setup()
        self.assertEqual(self.messages.list_messages(self.session_id), original)
        self.assertEqual([row["content"] for row in original], ["  Old question  ", "  Old answer  "])
        self.assertTrue(all(row["request_id"] == succeeded_id for row in original))
        for row in original:
            self.assertIsNotNone(row["created_at"])


if __name__ == "__main__":
    unittest.main()
