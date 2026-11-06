# 定义常见的工具

from config.config_anasize import get_config_value

from langchain_core.tools import StructuredTool
from .domain.common_tool_domain import CurrentTimeInput,WeatherInput
from .impl.common_tool_impl import get_current_time, get_weather
# ── Tool definitions ──

current_time_tool = StructuredTool.from_function(
    func=get_current_time,
    name="get_current_time",
    description="查询指定 IANA 时区的真实当前日期和时间。",
    args_schema=CurrentTimeInput,
)

weather_tool = StructuredTool.from_function(
    func=get_weather,
    name="get_weather",
    description="查询指定城市的天气信息。",
    args_schema=WeatherInput,
)
# 定义工具列表
common_tools = [current_time_tool, weather_tool]

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



