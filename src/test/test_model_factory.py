from copy import deepcopy
import inspect
import unittest
from unittest.mock import Mock, patch

from src.agents.english_teacher import agent_factory, model_factory


class ModelFactoryTests(unittest.TestCase):
    def setUp(self):
        for name, value in [("_catalog", None), ("_model", None), ("get_config_value", Mock()), ("ChatOllama", Mock())]:
            patcher = patch.object(model_factory, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.get_config = model_factory.get_config_value
        self.constructor = model_factory.ChatOllama
        self.config = {
            "default": "default-model",
            "models": [
                {"name": "other-model", "display_name": "Other model", "base_url": "http://other.invalid:11434", "temperature": 0},
                {"name": "default-model", "display_name": "Default model", "base_url": "http://default.invalid:11434", "temperature": 0.7},
            ],
        }
        self.get_config.return_value = self.config

    def assert_default_parameters(self):
        kwargs = self.constructor.call_args.kwargs
        self.assertEqual(kwargs["model"], "default-model")
        self.assertEqual(kwargs["base_url"], "http://default.invalid:11434")
        self.assertEqual(kwargs["temperature"], 0.7)

    def assert_invalid_config(self, config, field):
        self.get_config.return_value = config
        with self.assertRaisesRegex(ValueError, field):
            model_factory.get_model()
        self.constructor.assert_not_called()

    def test_default_selects_named_model_instead_of_first_model(self):
        self.assertIs(model_factory.get_model(), self.constructor.return_value)
        self.get_config.assert_called_once_with("model_list")
        self.assert_default_parameters()

    def test_cached_model_is_reused(self):
        first = model_factory.get_model()
        self.assertIs(model_factory.get_model(), first)
        self.constructor.assert_called_once()
        self.get_config.assert_called_once_with("model_list")

    def test_public_list_contains_only_names_and_display_names(self):
        self.config["models"][0]["api_key"] = "test-only-secret"
        self.config["models"][1]["extra_private_setting"] = "private"
        self.assertEqual(model_factory.get_model_list(), {
            "default": "default-model",
            "models": [
                {"name": "other-model", "display_name": "Other model"},
                {"name": "default-model", "display_name": "Default model"},
            ],
        })
        self.constructor.assert_not_called()

    def test_public_list_cannot_mutate_catalog(self):
        public = model_factory.get_model_list()
        public["default"] = "other-model"
        public["models"][0]["name"] = "mutated-name"
        public["models"].clear()
        current = model_factory.get_model_list()
        self.assertEqual(current["default"], "default-model")
        self.assertEqual([entry["name"] for entry in current["models"]], ["other-model", "default-model"])
        model_factory.get_model()
        self.assert_default_parameters()

    def test_optional_display_name_and_temperature_defaults(self):
        del self.config["models"][1]["display_name"]
        del self.config["models"][1]["temperature"]
        self.assertEqual(model_factory.get_model_list()["models"][1]["display_name"], "default-model")
        model_factory.get_model()
        self.assertEqual(self.constructor.call_args.kwargs["temperature"], 0)

    def test_nonnegative_temperature_has_no_artificial_upper_bound(self):
        self.config["models"][1]["temperature"] = 3.5
        model_factory.get_model()
        self.assertEqual(self.constructor.call_args.kwargs["temperature"], 3.5)

    def test_non_dictionary_catalog_is_rejected(self):
        for config in [None, [], "default-model", 123]:
            with self.subTest(config=config):
                self.assert_invalid_config(config, "model_list")

    def test_missing_or_empty_model_list_is_rejected(self):
        for models in [None, [], {}, "default-model"]:
            with self.subTest(models=models):
                self.assert_invalid_config({"default": "default-model", "models": models}, "model_list.models")

    def test_each_model_entry_must_be_a_dictionary(self):
        for entry in [None, [], "default-model", 123]:
            with self.subTest(entry=entry):
                self.assert_invalid_config({"default": "default-model", "models": [entry]}, "models")

    def test_default_must_be_a_nonempty_string(self):
        for default in [None, "", "   ", 123, {}]:
            with self.subTest(default=default):
                config = deepcopy(self.config)
                config["default"] = default
                self.assert_invalid_config(config, "default")

    def test_default_must_exist_without_falling_back_to_first(self):
        self.config["default"] = "unconfigured-model"
        self.assert_invalid_config(self.config, "default")

    def test_duplicate_model_names_are_rejected(self):
        self.config["models"][0]["name"] = "default-model"
        self.assert_invalid_config(self.config, "name")

    def test_required_model_fields_are_validated(self):
        for field in ["name", "base_url", "display_name"]:
            for value in [None, "", "   ", 123, {}]:
                with self.subTest(field=field, value=value):
                    config = deepcopy(self.config)
                    config["models"][0][field] = value
                    self.assert_invalid_config(config, field)

    def test_missing_name_or_base_url_is_rejected(self):
        for field in ["name", "base_url"]:
            with self.subTest(field=field):
                config = deepcopy(self.config)
                del config["models"][0][field]
                self.assert_invalid_config(config, field)

    def test_invalid_base_url_is_rejected(self):
        for url in ["localhost:11434", "file:///model", "https://", "http://host:invalid", "http://host:70000", "http://[invalid"]:
            with self.subTest(url=url):
                config = deepcopy(self.config)
                config["models"][1]["base_url"] = url
                self.assert_invalid_config(config, "base_url")

    def test_temperature_must_be_finite_nonnegative_number(self):
        for value in [None, True, False, -1, float("nan"), float("inf"), float("-inf"), "0.5", {}, 10 ** 1000]:
            with self.subTest(value=value):
                config = deepcopy(self.config)
                config["models"][1]["temperature"] = value
                self.assert_invalid_config(config, "temperature")

    def test_invalid_nondefault_model_is_not_ignored(self):
        self.config["models"][0]["temperature"] = -1
        with self.assertRaisesRegex(ValueError, "temperature"):
            model_factory.get_model_list()
        self.constructor.assert_not_called()

    def test_catalog_is_a_snapshot_even_when_source_config_changes(self):
        before = model_factory.get_model_list()
        self.config["default"] = "other-model"
        self.config["models"][1]["base_url"] = "http://changed.invalid"
        self.config["models"][1]["temperature"] = 1.5
        self.assertEqual(model_factory.get_model_list(), before)
        model_factory.get_model()
        self.assert_default_parameters()
        self.get_config.assert_called_once_with("model_list")

    def test_model_and_public_list_share_the_same_snapshot(self):
        model_factory.get_model()
        self.config["default"] = "other-model"
        self.assertEqual(model_factory.get_model_list()["default"], "default-model")
        self.get_config.assert_called_once_with("model_list")

    def test_new_process_state_can_select_changed_default(self):
        first, second = Mock(), Mock()
        self.constructor.side_effect = [first, second]
        self.assertIs(model_factory.get_model(), first)
        self.config["default"] = "other-model"
        self.assertIs(model_factory.get_model(), first)
        model_factory._catalog = None
        model_factory._model = None
        self.assertIs(model_factory.get_model(), second)
        self.assertEqual(self.constructor.call_args.kwargs["model"], "other-model")
        self.assertEqual(model_factory.get_model_list()["default"], "other-model")
        self.assertEqual(self.get_config.call_count, 2)

    def test_model_factory_has_no_custom_parameter_or_switch_api(self):
        self.assertEqual(list(inspect.signature(model_factory.get_model).parameters), [])
        self.assertEqual(list(inspect.signature(model_factory.get_model_list).parameters), [])
        self.assertFalse(hasattr(model_factory, "build_model"))
        for arguments in [{"model_name": "custom-model"}, {"base_url": "http://custom.invalid"}, {"temperature": 0.8}, {"switch_model": True}]:
            with self.subTest(arguments=arguments):
                with self.assertRaises(TypeError):
                    model_factory.get_model(**arguments)
        self.get_config.assert_not_called()
        self.constructor.assert_not_called()

    def test_http_timeout_configuration_is_preserved(self):
        model_factory.get_model()
        timeout = self.constructor.call_args.kwargs["client_kwargs"]["timeout"]
        self.assertEqual(timeout.connect, 5.0)
        self.assertEqual(timeout.read, 60.0)
        self.assertEqual(timeout.write, 60.0)
        self.assertEqual(timeout.pool, 60.0)


class AgentFactoryTests(unittest.TestCase):
    def test_agent_uses_configured_model_without_custom_parameters(self):
        model, checkpointer, tool = Mock(), Mock(), Mock()
        with patch.object(agent_factory, "get_model", return_value=model) as get_model, patch.object(agent_factory, "create_agent") as create_agent:
            result = agent_factory.build_agent(checkpointer, [tool])
        get_model.assert_called_once_with()
        create_agent.assert_called_once_with(
            model=model,
            tools=[tool],
            system_prompt=agent_factory.SYSTEM_PROMPT,
            checkpointer=checkpointer,
        )
        self.assertIs(result, create_agent.return_value)
        self.assertEqual(list(inspect.signature(agent_factory.build_agent).parameters), ["checkpointer", "tools"])

    def test_agent_rejects_custom_model_parameters(self):
        with patch.object(agent_factory, "get_model") as get_model:
            with self.assertRaises(TypeError):
                agent_factory.build_agent(None, [], model_name="custom-model")
        get_model.assert_not_called()


if __name__ == "__main__":
    unittest.main()
