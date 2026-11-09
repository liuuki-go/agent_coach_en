# 定义常见的工具
from datetime import datetime
import json
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

from config.config_anasize import get_config_value
from src.domains.error_domain import tool_error


def get_current_time(timezone: str) -> str:
    try:
        zone = ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return json.dumps(
            {
                "ok": False,
                "error": "无法读取该时区，请检查 IANA 时区名称或时区数据安装。",
            },
            ensure_ascii=False,
        )

    now = datetime.now(zone)

    return json.dumps(
        {
            "ok": True,
            "timezone": timezone,
            "datetime": now.isoformat(timespec="seconds"),
            "day_of_week": now.strftime("%A"),
        },
        ensure_ascii=False,
    )


def get_weather(city: str, unit: str = "celsius") -> str:
    city = city.strip()
    if not city:
        return tool_error("INVALID_CITY", "城市名称不能为空。")

    api_key = get_config_value("GAODE_API_KEY")
    if not api_key:
        return tool_error("WEATHER_CONFIG_ERROR", "天气服务尚未配置，请联系管理员。")

    try:
        city_code = resolve_adcode(city, api_key)
    except requests.Timeout:
        return tool_error("WEATHER_TIMEOUT", "城市查询超时，请稍后重试。")
    except requests.RequestException:
        return tool_error("WEATHER_REQUEST_FAILED", "暂时无法连接城市查询服务。")
    except ValueError:
        return tool_error("CITY_LOOKUP_FAILED", "未找到唯一城市，请提供更明确的省市名称。")
    except RuntimeError:
        return tool_error("CITY_SERVICE_ERROR", "城市查询服务返回异常，请稍后重试。")

    try:
        params = {
            "key": api_key,
            "city": city_code,
            "output": "JSON",
        }
        response = requests.get(
            "https://restapi.amap.com/v3/weather/weatherInfo",
            params=params,
            timeout=10,
        )
        response.raise_for_status()
    except requests.Timeout:
        return tool_error("WEATHER_TIMEOUT", "天气查询超时，请稍后重试。")
    except requests.RequestException:
        return tool_error("WEATHER_REQUEST_FAILED", "暂时无法连接天气服务。")

    try:
        data = response.json()
    except ValueError:
        return tool_error("WEATHER_RESPONSE_INVALID", "天气服务返回的数据格式无效。")

    if not isinstance(data, dict) or data.get("status") not in ("0", "1"):
        return tool_error("WEATHER_RESPONSE_INVALID", "天气服务返回的数据格式无效。")
    if data["status"] != "1":
        return tool_error("WEATHER_SERVICE_ERROR", "天气服务暂时无法完成查询，请稍后重试。")

    lives = data.get("lives", [])
    forecasts = data.get("forecasts", [])
    if (
        not ("lives" in data or "forecasts" in data)
        or not isinstance(lives, list)
        or not isinstance(forecasts, list)
        or not all(isinstance(item, dict) for item in lives + forecasts)
    ):
        return tool_error("WEATHER_RESPONSE_INVALID", "天气服务返回的数据格式无效。")

    return json.dumps(
        {"lives": lives, "forecasts": forecasts}, ensure_ascii=False
    )


def resolve_adcode(city: str, api_key: str) -> str:
    params = {
        "key": api_key,
        "keywords": city,
        "subdistrict": 0,
        "extensions": "base",
        "output": "JSON",
    }
    response = requests.get(
        "https://restapi.amap.com/v3/config/district",
        params=params,
        timeout=10,
    )
    response.raise_for_status()
    try:
        data = response.json()
    except ValueError:
        raise RuntimeError("城市查询响应不是有效 JSON") from None

    if not isinstance(data, dict) or data.get("status") != "1":
        raise RuntimeError("城市查询服务响应异常")

    districts = data.get("districts")
    if not isinstance(districts, list) or not all(
        isinstance(district, dict) for district in districts
    ):
        raise RuntimeError("城市查询结果格式无效")

    if not districts:
        raise ValueError("未找到精确匹配的地区，请确认中文名称")

    if len(districts) > 1:
        raise ValueError("存在同名地区，需要进一步限定省份")

    adcode = districts[0].get("adcode")
    if not isinstance(adcode, str) or not adcode.strip():
        raise RuntimeError("高德结果中缺少 adcode")
    return adcode.strip()
