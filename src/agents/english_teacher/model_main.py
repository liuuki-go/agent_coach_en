

from langchain_ollama import ChatOllama
from src.agent_tools.common_tool import tools as common_tool, execute_tool as common_execute_tool
from .template import SYSTEM_PROMPT

model = ChatOllama(
        model="qwen3.5:4b-q4_K_M",
        base_url="http://localhost:11434",
        temperature=0,
    )

# ── Initial message list ──
sys_message = {"role": "system", "content": SYSTEM_PROMPT}
history_messages = []
# ── Bind tools to the model ──
model_with_tools = model.bind_tools(common_tool)

def invoke(user_message):
    history_messages.append(sys_message) #加入系统消息
    history_messages.append(user_message) #加入用户消息

    # 模型回复
    for i in range(3):
        assistant_message = model_with_tools.invoke(history_messages)    
        history_messages.append(assistant_message)
        # 判断模型是否使用了tools，没有调用工具则是直接回答了
        if not assistant_message.tool_calls:
            "没有使用tools，直接返回模型回复"
            return assistant_message.content

        #使用了tools，执行tools,并保存tools的返回结果到history_messages中   
        for tool_call in assistant_message.tool_calls:
            result = common_execute_tool(tool_call["name"], tool_call["args"])
            history_messages.append({
                "role": "tool",
                "tool_call_id": tool_call["id"],
                "content": result,
            })
        
   

# test
if __name__ == "__main__":
    user_message = {"role": "user", "content": "请问广安市最近的天气如何？"}
    response = invoke(user_message)
    print("模型回复:", response)







