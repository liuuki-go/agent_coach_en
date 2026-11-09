from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.rows import DictRow

from src.common.third_party_types import DatabasePool


class MessageStore:
    def __init__(self, pool: DatabasePool):
        self.pool = pool

    def setup(self) -> None:
        with self.pool.connection() as connection:
            with connection.transaction():
                connection.execute("""
                    CREATE TABLE IF NOT EXISTS chat_messages (
                        id UUID PRIMARY KEY,
                        sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
                        session_id UUID NOT NULL REFERENCES chat_sessions(id),
                        request_id UUID REFERENCES chat_requests(request_id),
                        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                        content TEXT NOT NULL CHECK (btrim(content) <> ''),
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        UNIQUE (request_id, role)
                    )
                """)
                connection.execute("""
                    CREATE INDEX IF NOT EXISTS chat_messages_session_sequence_idx
                    ON chat_messages (session_id, sequence)
                """)
                # 只迁移有明确原文和最终回复的成功请求，不从 Checkpoint 猜消息身份。
                # created_at 使用本次归档时间，不能冒充历史消息的实际发送时间。
                connection.execute("""
                    INSERT INTO chat_messages (
                        id, session_id, request_id, role, content
                    )
                    SELECT gen_random_uuid(), r.session_id, r.request_id,
                           v.role, v.content
                    FROM chat_requests AS r
                    CROSS JOIN LATERAL (
                        VALUES (0, 'user', r.content), (1, 'assistant', r.reply)
                    ) AS v(position, role, content)
                    WHERE r.status = 'succeeded'
                        AND btrim(r.content) <> ''
                        AND r.reply IS NOT NULL AND btrim(r.reply) <> ''
                        AND NOT EXISTS (
                            SELECT 1 FROM chat_messages AS m
                            WHERE m.request_id = r.request_id AND m.role = v.role
                        )
                    ORDER BY r.created_at, r.request_id, v.position
                    ON CONFLICT (request_id, role) DO NOTHING
                """)

    def add_exchange(
        self,
        connection: Connection[DictRow],
        session_id: UUID,
        request_id: UUID | None,
        content: str,
        reply: str,
    ) -> None:
        """使用调用方的事务保存成功轮次；异常交给调用方统一回滚。"""
        connection.execute(
            """
                INSERT INTO chat_messages (id, session_id, request_id, role, content)
                VALUES (%s, %s, %s, 'user', %s),
                       (%s, %s, %s, 'assistant', %s)
            """,
            (uuid4(), session_id, request_id, content,
             uuid4(), session_id, request_id, reply),
        )

    def list_messages(self, session_id: UUID) -> list[DictRow]:
        with self.pool.connection() as connection:
            return connection.execute(
                """
                    SELECT id, sequence, session_id, request_id, role, content, created_at
                    FROM chat_messages
                    WHERE session_id = %s
                    ORDER BY sequence ASC
                """,
                (session_id,),
            ).fetchall()
