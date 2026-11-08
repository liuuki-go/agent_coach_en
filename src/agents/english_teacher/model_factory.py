from dataclasses import dataclass
from math import isfinite
from urllib.parse import urlsplit

import httpx
from langchain_ollama import ChatOllama

from config.config_anasize import get_config_value


@dataclass(frozen=True)
class _ConfiguredModel:
    name: str
    display_name: str
    base_url: str
    temperature: float


@dataclass(frozen=True)
class _ModelCatalog:
    default: str
    models: tuple[_ConfiguredModel, ...]


_catalog: _ModelCatalog | None = None
_model: ChatOllama | None = None


def _required_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} 必须是非空字符串")
    return value.strip()


def _get_catalog() -> _ModelCatalog:
    global _catalog
    if _catalog is not None:
        return _catalog

    config = get_config_value("model_list")
    if not isinstance(config, dict):
        raise ValueError("model_list 必须是字典")

    default = _required_string(config.get("default"), "model_list.default")
    entries = config.get("models")
    if not isinstance(entries, list) or not entries:
        raise ValueError("model_list.models 必须是非空列表")

    models = []
    names = set()
    for index, entry in enumerate(entries):
        field = f"model_list.models[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{field} 必须是字典")
        name = _required_string(entry.get("name"), f"{field}.name")
        if name in names:
            raise ValueError("model_list.models 的 name 不允许重复")
        names.add(name)
        display_name = _required_string(entry.get("display_name", name), f"{field}.display_name")
        base_url = _required_string(entry.get("base_url"), f"{field}.base_url")
        try:
            url = urlsplit(base_url)
            valid_url = url.scheme in {"http", "https"} and bool(url.hostname)
            _ = url.port
        except ValueError:
            valid_url = False
        if not valid_url:
            raise ValueError(f"{field}.base_url 必须是有效的 HTTP 或 HTTPS 地址")

        temperature = entry.get("temperature", 0)
        if isinstance(temperature, bool) or not isinstance(temperature, (int, float)):
            raise ValueError(f"{field}.temperature 必须是大于等于 0 的有限数值")
        try:
            temperature = float(temperature)
        except OverflowError:
            raise ValueError(f"{field}.temperature 必须是大于等于 0 的有限数值") from None
        if not isfinite(temperature) or temperature < 0:
            raise ValueError(f"{field}.temperature 必须是大于等于 0 的有限数值")

        models.append(_ConfiguredModel(name, display_name, base_url, temperature))

    if default not in names:
        raise ValueError("model_list.default 必须引用 models 中已配置的 name")

    _catalog = _ModelCatalog(default, tuple(models))
    return _catalog


def get_model() -> ChatOllama:
    global _model
    if _model is None:
        catalog = _get_catalog()
        selected = next(model for model in catalog.models if model.name == catalog.default)
        _model = ChatOllama(
            model=selected.name,
            base_url=selected.base_url,
            temperature=selected.temperature,
            client_kwargs={"timeout": httpx.Timeout(60.0, connect=5.0)},
        )
    return _model


def get_model_list() -> dict[str, object]:
    catalog = _get_catalog()
    return {
        "default": catalog.default,
        "models": [
            {"name": model.name, "display_name": model.display_name}
            for model in catalog.models
        ],
    }
