"""使用真实 Agent 图验证临时上下文选择；模型和工具仅为离线测试替身。"""

import unittest
from typing import Any

from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import Field

from src.agents.english_teacher.context_policy import ContextBudget, create_context_middleware
from src.domains.error_domain import ChatError


class RecordingChatModel(FakeMessagesListChatModel):
    calls: list[list[BaseMessage]] = Field(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any):
        self.calls.append([message.model_copy(deep=True) for message in messages])
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


class ContextIntegrationTests(unittest.TestCase):
    system_prompt = "SYS: Answer the current English-learning question."

    def build_agent(self, responses, tools=(), system_prompt=None):
        model = RecordingChatModel(responses=responses)
        budget = ContextBudget(
            context_window_tokens=1500,
            max_output_tokens=100,
            safety_margin_tokens=100,
            chars_per_token=1.0,
        )
        agent = create_agent(
            model=model,
            tools=list(tools),
            system_prompt=self.system_prompt if system_prompt is None else system_prompt,
            middleware=[create_context_middleware(budget)],
            checkpointer=InMemorySaver(),
        )
        return agent, model

    def config(self, thread_id="context-test"):
        return {"configurable": {"thread_id": thread_id}}

    def seed_long_history(self, agent, config):
        old_messages = [
            HumanMessage(content="OLD-LONG-" + "x" * 6000, id="old-user"),
            AIMessage(content="old final answer", id="old-assistant"),
        ]
        agent.update_state(config, {"messages": old_messages})
        return old_messages

    def test_multiple_turns_trim_model_input_but_keep_original_checkpoint_messages(self):
        agent, model = self.build_agent([
            AIMessage(content="recent answer"), AIMessage(content="current answer"),
        ])
        config = self.config()
        original = self.seed_long_history(agent, config)

        agent.invoke({"messages": [HumanMessage(content="recent question")]}, config)
        agent.invoke({"messages": [HumanMessage(content="current question")]}, config)

        self.assertEqual(len(model.calls), 2)
        for messages in model.calls:
            contents = [message.content for message in messages]
            self.assertEqual(contents[0], self.system_prompt)
            self.assertNotIn(original[0].content, contents)
            self.assertNotIn("old final answer", contents)
        self.assertEqual(
            [message.content for message in model.calls[-1]],
            [self.system_prompt, "recent question", "recent answer", "current question"],
        )
        saved = agent.get_state(config).values["messages"]
        self.assertEqual(len(saved), 6)
        self.assertEqual([message.content for message in saved[:2]], [message.content for message in original])
        self.assertEqual([message.id for message in saved[:2]], ["old-user", "old-assistant"])
        self.assertEqual(saved[-1].content, "current answer")

    def test_each_model_call_preserves_the_current_user_and_matching_tool_chain(self):
        @tool
        def test_weather() -> str:
            """Return deterministic local weather for an offline test."""
            return "WEATHER_RESULT: sunny and warm."

        agent, model = self.build_agent([
            AIMessage(content="", tool_calls=[{"name": test_weather.name, "args": {}, "id": "weather-1"}]),
            AIMessage(content="It is sunny."),
        ], tools=[test_weather])
        config = self.config()
        self.seed_long_history(agent, config)

        agent.invoke({"messages": [HumanMessage(content="What is the weather? Explain simply.")]}, config)

        self.assertEqual(len(model.calls), 2)
        for messages in model.calls:
            self.assertEqual(messages[0].content, self.system_prompt)
            self.assertEqual(messages[1].content, "What is the weather? Explain simply.")
            self.assertFalse(any(str(message.content).startswith("OLD-LONG-") for message in messages))
            self.assertNotIn("old final answer", [message.content for message in messages])
        current = model.calls[1]
        self.assertEqual([message.type for message in current], ["system", "human", "ai", "tool"])
        self.assertEqual(current[2].tool_calls[0]["id"], "weather-1")
        self.assertEqual(current[3].tool_call_id, "weather-1")
        self.assertEqual(current[3].content, "WEATHER_RESULT: sunny and warm.")
        saved = agent.get_state(config).values["messages"]
        self.assertTrue(any(message.id == "old-user" for message in saved))
        self.assertTrue(any(isinstance(message, ToolMessage) and message.tool_call_id == "weather-1" for message in saved))
        self.assertEqual(saved[-1].content, "It is sunny.")

    def test_current_input_over_budget_never_reaches_the_model(self):
        agent, model = self.build_agent([AIMessage(content="Must not run")])

        with self.assertRaises(ChatError) as raised:
            agent.invoke({"messages": [HumanMessage(content="current question " + "x" * 6000)]}, self.config())

        self.assertEqual(raised.exception.code, "CONTEXT_LIMIT_EXCEEDED")
        self.assertEqual(model.calls, [])

    def test_oversized_current_tool_result_stops_before_the_second_model_call(self):
        @tool
        def test_large_result() -> str:
            """Return a deliberately oversized result for an offline test."""
            return "TOO-LONG-RESULT-" + "x" * 6000

        agent, model = self.build_agent([
            AIMessage(content="", tool_calls=[{"name": test_large_result.name, "args": {}, "id": "large-1"}]),
            AIMessage(content="Must not run"),
        ], tools=[test_large_result])
        config = self.config()

        with self.assertRaises(ChatError) as raised:
            agent.invoke({"messages": [HumanMessage(content="Please inspect the result.")]}, config)

        self.assertEqual(raised.exception.code, "CONTEXT_LIMIT_EXCEEDED")
        self.assertEqual(len(model.calls), 1)
        saved = agent.get_state(config).values["messages"]
        self.assertTrue(any(
            isinstance(message, ToolMessage) and message.content.startswith("TOO-LONG-RESULT-")
            for message in saved
        ))
        self.assertFalse(any(message.content == "Must not run" for message in saved))

    def test_system_prompt_is_counted_even_though_it_is_not_in_state_messages(self):
        agent, model = self.build_agent([AIMessage(content="Must not run")], system_prompt="s" * 6000)

        with self.assertRaises(ChatError) as raised:
            agent.invoke({"messages": [HumanMessage(content="Hello")]}, self.config())

        self.assertEqual(raised.exception.code, "CONTEXT_LIMIT_EXCEEDED")
        self.assertEqual(model.calls, [])

    def test_tool_definitions_are_included_in_the_budget(self):
        @tool(description="d" * 6000)
        def test_expensive_definition() -> str:
            return "small result"

        agent, model = self.build_agent([AIMessage(content="Must not run")], tools=[test_expensive_definition])

        with self.assertRaises(ChatError) as raised:
            agent.invoke({"messages": [HumanMessage(content="Hello")]}, self.config())

        self.assertEqual(raised.exception.code, "CONTEXT_LIMIT_EXCEEDED")
        self.assertEqual(model.calls, [])

    def test_context_selection_uses_only_the_requested_thread(self):
        agent, model = self.build_agent([AIMessage(content="A answer"), AIMessage(content="B answer")])
        config_a, config_b = self.config("thread-a"), self.config("thread-b")
        for config, label in [(config_a, "A"), (config_b, "B")]:
            agent.update_state(config, {"messages": [
                HumanMessage(content=f"{label}-ONLY-HISTORY"),
                AIMessage(content=f"{label}-ONLY-ANSWER"),
            ]})

        agent.invoke({"messages": [HumanMessage(content="A current")]}, config_a)
        agent.invoke({"messages": [HumanMessage(content="B current")]}, config_b)

        first = [message.content for message in model.calls[0]]
        second = [message.content for message in model.calls[1]]
        self.assertIn("A-ONLY-HISTORY", first)
        self.assertNotIn("B-ONLY-HISTORY", first)
        self.assertIn("B-ONLY-HISTORY", second)
        self.assertNotIn("A-ONLY-HISTORY", second)
        self.assertNotIn("A current", second)
        state_b = agent.get_state(config_b).values["messages"]
        self.assertFalse(any(message.content == "A current" for message in state_b))


if __name__ == "__main__":
    unittest.main()
