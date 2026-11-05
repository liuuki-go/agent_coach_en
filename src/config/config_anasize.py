"解析json配置"
from pathlib import Path

import yaml

_config = None


def load_config():
    global _config

    config_path = Path(__file__).resolve().parent / "sys_config.yaml"

    with config_path.open("r", encoding="utf-8") as file:
        data = yaml.safe_load(file)

    if not isinstance(data, dict):
        raise ValueError("配置文件最外层必须是键值结构")

    _config = data


def get_config():
    if _config is None:
        load_config()
    return _config

def get_config_value(key, default=None):
    if _config is None:
        load_config()
    
    return _config.get(key, default)