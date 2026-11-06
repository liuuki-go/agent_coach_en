from pydantic import BaseModel, Field

class CurrentTimeInput(BaseModel):
    timezone: str = Field(
        min_length=1,
        description=(
            "IANA 时区名称，例如 Asia/Shanghai、America/Vancouver、UTC。"
        ),
    )

class WeatherInput(BaseModel):
    city: str = Field(
        min_length=1,
        description="城市的中文名称或英文名称，例如 北京、Beijing、纽约、New York、东京、Tokyo。",
    )