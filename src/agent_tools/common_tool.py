# 定义常见的工具
from datetime import datetime
import json
from zoneinfo import ZoneInfo
from src.config.config_anasize import get_config_value
import requests
# ── Tool definitions ──
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current date and time in a specific timezone",
            "parameters": {
                "type": "object",
                "properties": {
                    "timezone": {"type": "string", "description": "Timezone name, e.g. America/Vancouver"}
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a specific city",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name"},
                },
            },
        },
    },
]


# excute tool
def execute_tool(name, arguments):
    try:
        if name == "get_current_time":
            return get_current_time(arguments["timezone"])
        elif name == "get_weather":
            return get_weather(arguments["city"])
        else:
            return f"工具执行失败：不支持工具 {name}"
    except Exception as e:
        return f"工具执行失败: {e}"


def get_current_time(timezone:str):

    # 判断时区是否有效，无效则读取系统当前时区
    if timezone is None or timezone not in ZoneInfo.available_timezones():
        timezone = datetime.now().astimezone().tzinfo.key
    # 读取系统当前时间，并转换为指定时区。Windows 下建议先安装时区数据，让 ZoneInfo 能找到这些时区名称 pip install tzdata
    now = datetime.now(ZoneInfo(timezone))
    result = {
        "timezone": timezone,
        "datetime": now.isoformat(timespec="seconds"),
        "day_of_week": now.strftime("%A"),
    }
    return json.dumps(result)


def get_weather(city:str, unit:str="celsius"):
    #获取天气信息，使用配置文件中的API Key"
    api_key = get_config_value("GAODE_API_KEY")
    if not api_key:
        return "查询失败，请在配置文件中设置高德地图API Key"
    city = city.strip()
    if not city:
        return "查询失败,城市名称不能为空"
    try:
        city_code = resolve_adcode(city, api_key)
    except ValueError as e:
        return f"查询失败: {e}"
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
    except requests.RequestException:
        return "查询失败，请检查网络连接或高德地图API Key是否有效"
    data = response.json()
    if data.get("status") != "1":   
        return f"查询失败：{data.get('info')}，错误码：{data.get('infocode')}"
    lives = data.get("lives", [])
    forecasts = data.get("forecasts",[])
    return json.dumps({
        "lives": lives,
        "forecasts": forecasts
    },ensure_ascii=False
    )
    
    

        
'''
根据关键词获取城市的adcode，使用高德地图API
'''
def resolve_adcode(city: str, api_key: str) -> str:
    #获取城市poi信息

    params = {
        "key": api_key,
        "keywords": city,
        "subdistrict": 0,
        "extensions": "base",
        "output": "JSON",
    }
    try:
        response = requests.get(
            "https://restapi.amap.com/v3/config/district",
            params=params,
            timeout=10,
        )
        response.raise_for_status()
    except requests.RequestException:
        raise RuntimeError("高德请求失败或超时") 
    data = response.json()
    if data.get("status") != "1":
        raise RuntimeError(
            f"高德查询失败：{data.get('info')}，错误码：{data.get('infocode')}"
        )

    districts = data.get("districts", [])

    matches = [district for district in districts ]

    if not matches:
        raise ValueError("未找到精确匹配的地区，请确认中文名称")

    if len(matches) > 1:
        raise ValueError("存在同名地区，需要进一步限定省份")

    adcode = matches[0].get("adcode")
    if not adcode:
        raise RuntimeError("高德结果中缺少 adcode")
    return adcode