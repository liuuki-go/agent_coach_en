from uuid import UUID, uuid4

from psycopg.rows import DictRow

from src.common.third_party_types import DatabasePool

class SessionStore:
    def __init__(self, pool: DatabasePool):
        self.pool = pool

    # 首次使用，会新建表
    def setup(self) -> None:
        with self.pool.connection() as connection:
            connection.execute("""
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    id UUID PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)

    #新建会话时记录到数据库
    def create_session(self, title: str = "新的英语时光") -> DictRow:
        with self.pool.connection() as connection:
            row = connection.execute(
                """
                    INSERT INTO chat_sessions (id, title)
                    VALUES (%s, %s)
                    RETURNING id, title, created_at, updated_at
                """,
                (uuid4(), title),
            ).fetchone()

        if row is None:
            raise RuntimeError("创建会话后未获得数据库返回结果")

        return row

    # 查询所有会话
    def list_sessions(self) -> list[DictRow]:
        with self.pool.connection() as connection:
            return connection.execute("""
                SELECT id, title, created_at, updated_at
                FROM chat_sessions
                ORDER BY updated_at DESC, id DESC
            """).fetchall()

    # 根据会话ID查询会话
    def get_session(self, session_id: UUID) -> DictRow | None:
        with self.pool.connection() as connection:
            return connection.execute(
                """
                    SELECT id, title, created_at, updated_at
                    FROM chat_sessions
                    WHERE id = %s
                """,
                (session_id,),
            ).fetchone()

    def touch_session(self, session_id: UUID) -> bool:
        with self.pool.connection() as connection:
            cursor = connection.execute(
                """
                UPDATE chat_sessions
                SET updated_at = now()
                WHERE id = %s
                """,
                (session_id,),
            )
            return cursor.rowcount == 1
