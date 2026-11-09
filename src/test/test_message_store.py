import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID

from src.common.db.message_store import MessageStore


class MessageStoreTests(unittest.TestCase):
    session_id = UUID("11111111-1111-4111-8111-111111111111")
    request_id = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    user_id = UUID("22222222-2222-4222-8222-222222222222")
    assistant_id = UUID("33333333-3333-4333-8333-333333333333")

    def setUp(self):
        self.pool = MagicMock()
        self.connection = self.pool.connection.return_value.__enter__.return_value
        self.cursor = self.connection.execute.return_value
        self.store = MessageStore(self.pool)

    def test_setup_creates_and_backfills_with_one_connection_and_transaction(self):
        events = []
        transaction = self.connection.transaction.return_value
        transaction.__enter__.side_effect = lambda: events.append("begin")
        transaction.__exit__.side_effect = lambda *args: events.append("end") or False
        self.connection.execute.side_effect = lambda *args: events.append("execute")

        self.store.setup()

        self.assertEqual(events, ["begin", "execute", "execute", "execute", "end"])
        self.pool.connection.assert_called_once_with()
        self.connection.transaction.assert_called_once_with()
        statements = [" ".join(call.args[0].split())
                      for call in self.connection.execute.call_args_list]
        self.assertIn("CREATE TABLE IF NOT EXISTS chat_messages", statements[0])
        self.assertIn("GENERATED ALWAYS AS IDENTITY UNIQUE", statements[0])
        self.assertIn("UNIQUE (request_id, role)", statements[0])
        self.assertIn("ON chat_messages (session_id, sequence)", statements[1])
        self.assertTrue(statements[2].startswith("INSERT INTO chat_messages"))
        self.connection.commit.assert_not_called()

    def test_backfill_only_copies_valid_successes_once_in_conversation_order(self):
        self.store.setup()

        args = self.connection.execute.call_args.args
        sql = " ".join(args[0].split())
        self.assertEqual(len(args), 1)
        self.assertIn("gen_random_uuid()", sql)
        self.assertIn("(0, 'user', r.content), (1, 'assistant', r.reply)", sql)
        self.assertIn("WHERE r.status = 'succeeded'", sql)
        self.assertIn("btrim(r.content) <> ''", sql)
        self.assertIn("r.reply IS NOT NULL AND btrim(r.reply) <> ''", sql)
        self.assertIn("NOT EXISTS", sql)
        self.assertIn("m.request_id = r.request_id AND m.role = v.role", sql)
        self.assertIn("ORDER BY r.created_at, r.request_id, v.position", sql)
        self.assertIn("ON CONFLICT (request_id, role) DO NOTHING", sql)
        columns = sql.partition("SELECT")[0]
        self.assertNotIn("created_at", columns)
        self.assertNotIn("checkpoint", sql.lower())

    def test_setup_errors_leave_the_transaction_and_release_the_connection(self):
        for failing_statement in range(3):
            with self.subTest(failing_statement=failing_statement):
                self.setUp()
                error = RuntimeError("Database unavailable")
                self.connection.execute.side_effect = [None] * failing_statement + [error]

                with self.assertRaises(RuntimeError) as raised:
                    self.store.setup()

                self.assertIs(raised.exception, error)
                transaction = self.connection.transaction.return_value
                self.assertIs(transaction.__exit__.call_args.args[1], error)
                self.pool.connection.return_value.__exit__.assert_called_once()
                self.connection.commit.assert_not_called()

    def test_exchange_binds_original_text_and_writes_both_messages_on_external_connection(self):
        connection = MagicMock()
        content = "  It's a question; 你好!\n  "
        reply = "  Here's the actual reply.  "
        with patch("src.common.db.message_store.uuid4", side_effect=[self.user_id, self.assistant_id]):
            self.store.add_exchange(connection, self.session_id, self.request_id, content, reply)

        connection.execute.assert_called_once()
        sql, parameters = connection.execute.call_args.args
        self.assertEqual(parameters, (
            self.user_id, self.session_id, self.request_id, content,
            self.assistant_id, self.session_id, self.request_id, reply,
        ))
        self.assertNotIn(content, sql)
        self.assertNotIn(reply, sql)
        self.assertLess(sql.index("'user'"), sql.index("'assistant'"))
        self.assertNotIn("ON CONFLICT", sql)
        self.pool.connection.assert_not_called()
        connection.transaction.assert_not_called()
        connection.commit.assert_not_called()

    def test_legacy_exchange_keeps_request_id_null_without_creating_requests(self):
        connection = MagicMock()

        self.store.add_exchange(connection, self.session_id, None, "Hello", "Hi")

        sql, parameters = connection.execute.call_args.args
        self.assertIsNone(parameters[2])
        self.assertIsNone(parameters[6])
        self.assertNotIn("chat_requests", sql)
        self.pool.connection.assert_not_called()
        connection.commit.assert_not_called()

    def test_exchange_does_not_hide_write_errors_or_finish_the_callers_transaction(self):
        connection = MagicMock()
        error = RuntimeError("Write failed")
        connection.execute.side_effect = error

        with self.assertRaises(RuntimeError) as raised:
            self.store.add_exchange(connection, self.session_id, self.request_id, "Hello", "Hi")

        self.assertIs(raised.exception, error)
        self.pool.connection.assert_not_called()
        connection.commit.assert_not_called()
        connection.rollback.assert_not_called()

    def test_list_filters_the_requested_session_and_preserves_business_fields(self):
        rows = [{
            "id": self.user_id,
            "sequence": 7,
            "session_id": self.session_id,
            "request_id": self.request_id,
            "role": "user",
            "content": "Original text",
            "created_at": datetime(2026, 11, 9, tzinfo=timezone.utc),
        }]
        self.cursor.fetchall.return_value = rows

        self.assertIs(self.store.list_messages(self.session_id), rows)

        sql, parameters = self.connection.execute.call_args.args
        sql = " ".join(sql.split())
        self.assertEqual(parameters, (self.session_id,))
        self.assertIn("id, sequence, session_id, request_id, role, content, created_at", sql)
        self.assertIn("WHERE session_id = %s", sql)
        self.assertIn("ORDER BY sequence ASC", sql)
        self.pool.connection.return_value.__exit__.assert_called_once()

    def test_empty_archive_is_returned_as_an_empty_list(self):
        self.cursor.fetchall.return_value = []

        self.assertEqual(self.store.list_messages(self.session_id), [])
        self.connection.execute.assert_called_once()

    def test_read_errors_are_propagated_and_connection_released(self):
        error = RuntimeError("Read failed")
        self.connection.execute.side_effect = error

        with self.assertRaises(RuntimeError) as raised:
            self.store.list_messages(self.session_id)

        self.assertIs(raised.exception, error)
        self.pool.connection.return_value.__exit__.assert_called_once()


if __name__ == "__main__":
    unittest.main()
