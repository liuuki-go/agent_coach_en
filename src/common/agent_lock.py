from threading import Lock
from uuid import UUID


class SessionLocks:
    def __init__(self):
        self._guard = Lock()
        self._locks: dict[UUID, Lock] = {}

    def get(self, session_id: UUID) -> Lock:
        with self._guard:
            return self._locks.setdefault(session_id, Lock())