
from uuid import UUID

from psycopg import Connection
from psycopg.rows import DictRow

from src.common.third_party_types import DatabasePool


class RequestStore:
    def __init__(self, pool: DatabasePool):
        self.pool = pool

    def setup(self) -> None:
        with self.pool.connection() as connection:
            connection.execute("""
                CREATE TABLE IF NOT EXISTS chat_requests (
                    request_id UUID PRIMARY KEY,
                    session_id UUID NOT NULL REFERENCES chat_sessions(id),
                    content TEXT NOT NULL,
                    status TEXT NOT NULL
                        CHECK (status IN ('processing', 'succeeded', 'failed')),
                    reply TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

                    CHECK (status <> 'succeeded' OR reply IS NOT NULL),
                    CHECK (
                        status <> 'failed'
                        OR (
                            error_code IS NOT NULL
                            AND error_message IS NOT NULL
                        )
                    )
                )
            """)


    def try_start(
        self,
        request_id: UUID,
        session_id: UUID,
        content: str,
    ) -> DictRow | None:
        with self.pool.connection() as connection:
            return connection.execute(
                """
                    INSERT INTO chat_requests (
                        request_id, session_id, content, status
                    )
                    VALUES (%s, %s, %s, 'processing')
                    ON CONFLICT (request_id) DO NOTHING
                    RETURNING request_id, session_id, content, status,
                                reply, error_code, error_message,
                                created_at, updated_at
                """,
                (request_id, session_id, content),
            ).fetchone()


    def get_request(self, request_id: UUID) -> DictRow | None:
        with self.pool.connection() as connection:
            return connection.execute(
                """
                    SELECT request_id, session_id, content, status,
                            reply, error_code, error_message,
                            created_at, updated_at
                    FROM chat_requests
                    WHERE request_id = %s
                """,
                (request_id,),
            ).fetchone()

    def mark_succeeded(
        self,
        request_id: UUID,
        reply: str,
        *,
        connection: Connection[DictRow] | None = None,
    ) -> bool:
        if connection is None:
            with self.pool.connection() as own_connection:
                return self.mark_succeeded(request_id, reply, connection=own_connection)

        # 使用调用方的连接，不自行提交，使请求终态和消息归档共享事务。
        cursor = connection.execute(
            """
                UPDATE chat_requests
                SET status = 'succeeded',
                    reply = %s,
                    error_code = NULL,
                    error_message = NULL,
                    updated_at = now()
                WHERE request_id = %s
                    AND status = 'processing'
            """,
            (reply, request_id),
        )
        return cursor.rowcount == 1

    def mark_failed(
        self,
        request_id: UUID,
        error_code: str,
        error_message: str,
    ) -> bool:
        with self.pool.connection() as connection:
            cursor = connection.execute(
                """
                    UPDATE chat_requests
                    SET status = 'failed',
                        reply = NULL,
                        error_code = %s,
                        error_message = %s,
                        updated_at = now()
                    WHERE request_id = %s
                        AND status = 'processing'
                """,
                (error_code, error_message, request_id),
            )
            return cursor.rowcount == 1
