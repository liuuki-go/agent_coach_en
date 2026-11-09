import unittest
from unittest.mock import MagicMock
from uuid import UUID

from src.common.db.request_store import RequestStore


class RequestStoreTests(unittest.TestCase):
    request_id = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    session_id = UUID("11111111-1111-4111-8111-111111111111")

    def setUp(self):
        self.pool = MagicMock()
        self.connection = self.pool.connection.return_value.__enter__.return_value
        self.cursor = self.connection.execute.return_value
        self.store = RequestStore(self.pool)

    def sql_and_parameters(self):
        args = self.connection.execute.call_args.args
        return " ".join(args[0].split()), args[1]

    def test_start_returns_the_inserted_record_and_binds_the_original_input(self):
        content = "  It's a quoted question; 你好!  "
        record = {"request_id": self.request_id, "status": "processing"}
        self.cursor.fetchone.return_value = record

        self.assertEqual(
            self.store.try_start(self.request_id, self.session_id, content), record
        )

        sql, parameters = self.sql_and_parameters()
        self.assertEqual(parameters, (self.request_id, self.session_id, content))
        self.assertNotIn(content, sql)
        self.assertIn("ON CONFLICT (request_id) DO NOTHING", sql)
        self.assertIn("RETURNING", sql)
        self.pool.connection.return_value.__exit__.assert_called_once()

    def test_start_returns_none_when_the_atomic_insert_does_not_create_a_row(self):
        self.cursor.fetchone.return_value = None
        self.assertIsNone(self.store.try_start(self.request_id, self.session_id, "Hello"))
        self.connection.execute.assert_called_once()

    def test_get_request_returns_a_record_or_none_without_creating_a_request(self):
        for record in [None, {"request_id": self.request_id, "status": "succeeded"}]:
            with self.subTest(record=record):
                self.connection.execute.reset_mock()
                self.cursor.fetchone.return_value = record
                self.assertEqual(self.store.get_request(self.request_id), record)
                sql, parameters = self.sql_and_parameters()
                self.assertEqual(parameters, (self.request_id,))
                self.assertIn("WHERE request_id = %s", sql)
                self.assertTrue(sql.startswith("SELECT "))
                self.connection.execute.assert_called_once()

    def test_success_only_updates_processing_and_reports_whether_a_row_changed(self):
        reply = "  It's a saved reply.  "
        for rowcount, expected in [(1, True), (0, False)]:
            with self.subTest(rowcount=rowcount):
                self.cursor.rowcount = rowcount
                self.assertIs(self.store.mark_succeeded(self.request_id, reply), expected)
                sql, parameters = self.sql_and_parameters()
                self.assertEqual(parameters, (reply, self.request_id))
                self.assertIn("WHERE request_id = %s AND status = 'processing'", sql)
                self.assertIn("status = 'succeeded'", sql)

    def test_failure_only_updates_processing_and_binds_the_safe_error(self):
        for rowcount, expected in [(1, True), (0, False)]:
            with self.subTest(rowcount=rowcount):
                self.cursor.rowcount = rowcount
                self.assertIs(
                    self.store.mark_failed(self.request_id, "MODEL_TIMEOUT", "模型响应超时"),
                    expected,
                )
                sql, parameters = self.sql_and_parameters()
                self.assertEqual(parameters, ("MODEL_TIMEOUT", "模型响应超时", self.request_id))
                self.assertIn("WHERE request_id = %s AND status = 'processing'", sql)
                self.assertIn("status = 'failed'", sql)

    def test_success_uses_the_supplied_connection_without_owning_its_transaction(self):
        connection = MagicMock()
        reply = "  It's a shared-transaction reply.  "
        for rowcount, expected in [(1, True), (0, False)]:
            with self.subTest(rowcount=rowcount):
                connection.execute.reset_mock()
                connection.execute.return_value.rowcount = rowcount

                self.assertIs(
                    self.store.mark_succeeded(self.request_id, reply, connection=connection),
                    expected,
                )

                sql, parameters = connection.execute.call_args.args
                self.assertEqual(parameters, (reply, self.request_id))
                self.assertIn("AND status = 'processing'", " ".join(sql.split()))
                connection.execute.assert_called_once()
                self.pool.connection.assert_not_called()
                connection.commit.assert_not_called()
                connection.rollback.assert_not_called()
                connection.transaction.assert_not_called()
                connection.close.assert_not_called()
                connection.__enter__.assert_not_called()
                connection.__exit__.assert_not_called()

    def test_supplied_connection_failure_propagates_to_the_outer_transaction(self):
        connection = MagicMock()
        error = RuntimeError("Shared transaction failed")
        connection.execute.side_effect = error

        with self.assertRaises(RuntimeError) as raised:
            self.store.mark_succeeded(self.request_id, "Reply", connection=connection)

        self.assertIs(raised.exception, error)
        self.pool.connection.assert_not_called()
        connection.commit.assert_not_called()
        connection.rollback.assert_not_called()
        connection.close.assert_not_called()
        connection.__enter__.assert_not_called()
        connection.__exit__.assert_not_called()

    def test_database_errors_are_propagated_and_connections_are_released(self):
        operations = [
            self.store.setup,
            lambda: self.store.try_start(self.request_id, self.session_id, "Hello"),
            lambda: self.store.get_request(self.request_id),
            lambda: self.store.mark_succeeded(self.request_id, "Reply"),
            lambda: self.store.mark_failed(self.request_id, "MODEL_TIMEOUT", "超时"),
        ]
        for operation in operations:
            with self.subTest(operation=operation):
                self.pool.connection.return_value.__exit__.reset_mock()
                error = RuntimeError("Database unavailable")
                self.connection.execute.side_effect = error
                with self.assertRaises(RuntimeError) as raised:
                    operation()
                self.assertIs(raised.exception, error)
                self.pool.connection.return_value.__exit__.assert_called_once()


if __name__ == "__main__":
    unittest.main()
