from fastapi import FastAPI
from uvicorn import run
from pydantic import BaseModel
from src.agents.english_teacher.model_main import invoke

app = FastAPI(title="langchain-ollama-agent", description="A simple agent using langchain-ollama", version="0.1.0")


class user_message(BaseModel):
    content: str


@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/api/chat")
def chat(request: user_message):
    "重置role为user"
    role:str = 'user'
    user_message = {"role": role, "content": request.content}
    return invoke(user_message)

"启动服务器"
if __name__ == "__main__":
    run(app, host="127.0.0.1", port=6576)