from psycopg.rows import dict_row

from config.config_anasize import get_config_value
from src.common.third_party_types import DatabasePool


def create_db_pool() -> DatabasePool:
    db_info = get_config_value("Data_Base")
    if not isinstance(db_info, dict):
        raise ValueError("配置文件中缺少 Data_Base")

    return DatabasePool(
        kwargs={
            "host": db_info["host"],
            "port": db_info.get("port", 5432),
            "dbname": db_info["database"],
            "user": db_info["user"],
            "password": db_info["password"],
            "connect_timeout": 5,
            "autocommit": True,
            "row_factory": dict_row,
        },
        min_size=1,
        max_size=4,
        timeout=5,
        open=False,
    )
