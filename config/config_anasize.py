from pathlib import Path

import yaml


_config: dict | None = None


def load_config() -> dict:
    config_path = Path(__file__).resolve().parent / "sys_config.yaml"

    with config_path.open("r", encoding="utf-8") as file:
        data = yaml.safe_load(file)

    if not isinstance(data, dict):
        raise ValueError("配置文件最外层必须是键值结构")

    return data


def get_config() -> dict:
    global _config

    if _config is None:
        _config = load_config()

    return _config


def get_config_value(key, default=None):
    return get_config().get(key, default)