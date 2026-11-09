import unittest
from unittest.mock import Mock, patch
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from src.agents.english_teacher.agent_runner import invoke


class AgentRunnerTests(unittest.TestCase):
    session_id = UUID("11111111-1111-4111-8111-111111111111")

    def setUp(self):
        self.agent = Mock()
        self.user_message = {"role": "user", "content": "  Hello, Teresa!  "}

    def test_only_current_message_is_sent_with_the_server_managed_thread_id(self):
        self.agent.invoke.return_value = {
            "messages": [
                HumanMessage(content="An earlier question"),
                AIMessage(content="An earlier reply"),
                HumanMessage(content=self.user_message["content"]),
                AIMessage(content="  Hello, student!  "),
            ]
        }

        reply = invoke(self.user_message, self.agent, self.session_id)

        self.assertEqual(reply, "  Hello, student!  ")
        self.agent.invoke.assert_called_once_with(
            {"messages": [self.user_message]},
            config={"configurable": {"thread_id": str(self.session_id)}},
        )
        self.assertEqual(
            self.user_message, {"role": "user", "content": "  Hello, Teresa!  "}
        )

    def test_tool_round_trip_returns_the_final_assistant_reply(self):
        self.agent.invoke.return_value = {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "get_current_time", "args": {}, "id": "call-1"}
                    ],
                ),
                ToolMessage(
                    content="12:00", name="get_current_time", tool_call_id="call-1"
                ),
                AIMessage(content="It is twelve o'clock."),
            ]
        }

        with patch("builtins.print"):
            reply = invoke(self.user_message, self.agent, self.session_id)

        self.assertEqual(reply, "It is twelve o'clock.")

    def test_missing_or_empty_messages_are_rejected(self):
        for result in [{}, {"messages": []}]:
            with self.subTest(result=result):
                self.agent.invoke.return_value = result
                with self.assertRaisesRegex(RuntimeError, "Agent 没有返回消息"):
                    invoke(self.user_message, self.agent, self.session_id)

    def test_nonfinal_messages_are_not_returned_as_the_assistant_reply(self):
        final_messages = [
            HumanMessage(content="A user message"),
            ToolMessage(content="A tool result", tool_call_id="call-1"),
            AIMessage(
                content="Let me check.",
                tool_calls=[
                    {"name": "get_current_time", "args": {}, "id": "call-1"}
                ],
            ),
        ]
        for message in final_messages:
            with self.subTest(message=message):
                self.agent.invoke.return_value = {"messages": [message]}
                with patch("builtins.print"):
                    with self.assertRaisesRegex(
                        RuntimeError, "Agent 没有返回最终回复"
                    ):
                        invoke(self.user_message, self.agent, self.session_id)

    def test_empty_or_nontext_final_assistant_content_is_rejected(self):
        for content in ["", " \t\r\n ", [{"type": "text", "text": "A block"}]]:
            with self.subTest(content=content):
                self.agent.invoke.return_value = {
                    "messages": [AIMessage(content=content)]
                }
                with self.assertRaisesRegex(RuntimeError, "Agent 没有返回有效的文字回复"):
                    invoke(self.user_message, self.agent, self.session_id)

    def test_agent_failure_is_propagated_to_the_service(self):
        error = RuntimeError("Model invocation failed")
        self.agent.invoke.side_effect = error

        with self.assertRaises(RuntimeError) as raised:
            invoke(self.user_message, self.agent, self.session_id)

        self.assertIs(raised.exception, error)


if __name__ == "__main__":
    unittest.main()
