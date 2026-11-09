import unittest
from copy import deepcopy
from unittest.mock import Mock, patch

from langchain.agents.middleware import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.messages.utils import count_tokens_approximately
from pydantic import ValidationError

from src.agents.english_teacher import context_policy
from src.agents.english_teacher.context_policy import ContextBudget, create_context_middleware, select_context_messages
from src.domains.error_domain import ChatError


def budget_for_input(tokens, chars_per_token=1.0):
    return ContextBudget(
        context_window_tokens=tokens + 150, max_output_tokens=100,
        safety_margin_tokens=50, chars_per_token=chars_per_token,
    )


class ContextBudgetTests(unittest.TestCase):
    def setUp(self):
        context_policy.get_context_budget.cache_clear()
        self.addCleanup(context_policy.get_context_budget.cache_clear)
        self.config = {
            "context_window_tokens": 8192, "max_output_tokens": 1024,
            "safety_margin_tokens": 512, "chars_per_token": 1.0,
        }

    def test_input_budget_is_derived_and_config_is_immutable(self):
        budget = ContextBudget(**self.config)
        self.assertEqual(budget.input_budget_tokens, 6656)
        with self.assertRaises(ValidationError):
            budget.max_output_tokens = 1

    def test_integer_fields_reject_coercion_boolean_and_invalid_ranges(self):
        for field in ("context_window_tokens", "max_output_tokens", "safety_margin_tokens"):
            invalid = [True, False, "100", 1.5, -1, None]
            if field != "safety_margin_tokens":
                invalid.append(0)
            for value in invalid:
                with self.subTest(field=field, value=value):
                    with self.assertRaises(ValidationError):
                        ContextBudget(**{**self.config, field: value})

    def test_counter_ratio_must_be_a_finite_positive_number(self):
        for value in (True, False, "1.0", 0, -1, float("inf"), float("nan"), None):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    ContextBudget(**{**self.config, "chars_per_token": value})

    def test_missing_unknown_fields_and_exhausted_input_budget_are_rejected(self):
        for field in self.config:
            config = self.config.copy()
            del config[field]
            with self.subTest(missing=field), self.assertRaises(ValidationError):
                ContextBudget(**config)
        with self.assertRaises(ValidationError):
            ContextBudget(**self.config, typo=1)
        for window in (1536, 1000):
            with self.subTest(window=window), self.assertRaises(ValidationError):
                ContextBudget(**{**self.config, "context_window_tokens": window})

    def test_loaded_config_is_a_cached_snapshot(self):
        with patch.object(context_policy, "get_config_value", return_value=self.config) as get_config:
            first = context_policy.get_context_budget()
            self.config["context_window_tokens"] = 16384
            self.assertIs(context_policy.get_context_budget(), first)
            self.assertEqual(first.context_window_tokens, 8192)
            get_config.assert_called_once_with("context_budget")

    def test_missing_or_nondictionary_section_is_an_explicit_startup_error(self):
        for value in (None, [], "8192", 8192):
            with self.subTest(value=value), patch.object(context_policy, "get_config_value", return_value=value):
                with self.assertRaisesRegex(ValueError, "context_budget"):
                    context_policy.get_context_budget()


class ContextSelectionTests(unittest.TestCase):
    def select(self, messages, tokens=2000, system=None, tools=None):
        return select_context_messages(
            messages, system_message=system, tools=tools or [], budget=budget_for_input(tokens),
        )

    def tool_turn(self):
        return [
            HumanMessage(content="查看天气，并用英文解释"),
            AIMessage(content="", tool_calls=[
                {"name": "weather", "args": {"city": "上海"}, "id": "call-1"},
                {"name": "time", "args": {}, "id": "call-2"},
            ]),
            ToolMessage(content="12:00", tool_call_id="call-2"),
            ToolMessage(content="晴天", tool_call_id="call-1"),
        ]

    def test_messages_that_fit_are_preserved_without_mutating_original_objects(self):
        messages = [HumanMessage(content="Hello"), AIMessage(content="Hi"), HumanMessage(content="你好")]
        original = deepcopy(messages)
        selected = self.select(messages)
        self.assertEqual(selected, original)
        self.assertEqual(messages, original)
        self.assertIsNot(selected, messages)
        self.assertTrue(all(left is right for left, right in zip(selected, messages)))

    def test_oldest_turn_is_removed_whole_and_recent_turn_and_current_text_are_preserved(self):
        recent = [HumanMessage(content="recent"), AIMessage(content="answer")]
        current = HumanMessage(content="现在的问题")
        messages = [HumanMessage(content="old" * 500), AIMessage(content="old answer"), *recent, current]
        selected = self.select(messages, tokens=80)
        self.assertEqual(selected, [*recent, current])
        self.assertEqual(messages[0].content, "old" * 500)

    def test_partial_historical_turn_is_not_left_as_an_orphan_assistant_message(self):
        messages = [HumanMessage(content="large" * 100), AIMessage(content="short answer"), HumanMessage(content="current")]
        selected = self.select(messages, tokens=60)
        self.assertEqual(selected, messages[-1:])

    def test_current_parallel_tool_chain_is_kept_and_old_history_is_dropped(self):
        current = self.tool_turn()
        messages = [HumanMessage(content="old" * 500), AIMessage(content="old answer"), *current]
        required = count_tokens_approximately(current, chars_per_token=1.0)
        self.assertEqual(self.select(messages, tokens=required), current)

    def test_older_tool_turn_is_either_kept_complete_or_removed_complete(self):
        old = [*self.tool_turn(), AIMessage(content="The weather is sunny.")]
        current = HumanMessage(content="next")
        self.assertEqual(self.select([*old, current], tokens=1000), [*old, current])
        self.assertEqual(self.select([*old, current], tokens=60), [current])

    def test_system_and_tool_schemas_reduce_the_available_history_budget(self):
        messages = [HumanMessage(content="old question"), AIMessage(content="old reply"), HumanMessage(content="current")]
        system = SystemMessage(content="教学要求" * 10)
        tools = [{"type": "function", "function": {"name": "weather", "description": "天气查询" * 8, "parameters": {"type": "object", "properties": {}}}}]
        required = count_tokens_approximately([system, messages[-1]], chars_per_token=1.0, tools=tools)
        self.assertEqual(self.select(messages, tokens=required, system=system, tools=tools), messages[-1:])
        with self.assertRaises(ChatError) as raised:
            self.select(messages, tokens=required - 1, system=system, tools=tools)
        self.assertEqual(raised.exception.code, "CONTEXT_LIMIT_EXCEEDED")

    def test_current_question_or_tool_result_cannot_be_silently_truncated(self):
        for messages in ([HumanMessage(content="当前问题" * 100)], [*self.tool_turn()[:-1], ToolMessage(content="结果" * 200, tool_call_id="call-1")]):
            with self.subTest(messages=messages), self.assertRaises(ChatError) as raised:
                self.select(messages, tokens=50)
            self.assertEqual(raised.exception.code, "CONTEXT_LIMIT_EXCEEDED")

    def test_missing_user_and_incomplete_or_duplicate_tool_results_are_rejected(self):
        invalid = [
            [], [AIMessage(content="no user")],
            [HumanMessage(content="Hi"), ToolMessage(content="orphan", tool_call_id="x")],
            self.tool_turn()[:-1],
            [*self.tool_turn(), ToolMessage(content="duplicate", tool_call_id="call-1")],
            [HumanMessage(content="Hi"), AIMessage(content="", tool_calls=[
                {"name": "tool", "args": {}, "id": "same"},
                {"name": "tool", "args": {}, "id": "same"},
            ])],
        ]
        for messages in invalid:
            with self.subTest(messages=messages), self.assertRaises(ChatError) as raised:
                self.select(messages)
            self.assertEqual(raised.exception.code, "CONTEXT_STATE_INVALID")

    def test_success_and_rejection_logs_only_include_numeric_budget_metadata(self):
        secret = "private-original-text"
        with self.assertLogs(context_policy.__name__, level="INFO") as logs:
            self.select([HumanMessage(content=secret)], tokens=100)
            with self.assertRaises(ChatError):
                self.select([HumanMessage(content=secret * 20)], tokens=30)
        text = " ".join(logs.output)
        self.assertIn("estimated_input_tokens_after=", text)
        self.assertIn("context_budget_exceeded", text)
        self.assertNotIn(secret, text)

    def test_middleware_overrides_only_the_call_and_preserves_saved_state(self):
        messages = [HumanMessage(content="old" * 300), AIMessage(content="old answer"), HumanMessage(content="current")]
        state = {"messages": messages}
        original = deepcopy(state)
        request = ModelRequest(model=Mock(), messages=messages, system_message=SystemMessage(content="Teach"), tools=[], state=state)
        handler = Mock(return_value=object())
        middleware = create_context_middleware(budget_for_input(80))
        self.assertIs(middleware.wrap_model_call(request, handler), handler.return_value)
        forwarded = handler.call_args.args[0]
        self.assertIsNot(forwarded, request)
        self.assertEqual(forwarded.messages, messages[-1:])
        self.assertIs(forwarded.state, state)
        self.assertIs(forwarded.system_message, request.system_message)
        self.assertEqual(request.messages, messages)
        self.assertEqual(state, original)

    def test_middleware_does_not_invoke_model_when_required_input_exceeds_budget(self):
        request = ModelRequest(model=Mock(), messages=[HumanMessage(content="too long" * 100)], tools=[], state={})
        handler = Mock()
        middleware = create_context_middleware(budget_for_input(30))
        with self.assertRaises(ChatError) as raised:
            middleware.wrap_model_call(request, handler)
        self.assertEqual(raised.exception.code, "CONTEXT_LIMIT_EXCEEDED")
        handler.assert_not_called()


if __name__ == "__main__":
    unittest.main()
