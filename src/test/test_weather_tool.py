import json
import unittest
from unittest.mock import Mock, patch

import requests

from src.agent_tools.impl import common_tool_impl


class WeatherToolTests(unittest.TestCase):
    fake_key = "test-weather-key-do-not-echo"
    fake_url = "https://example.invalid/weather?key=" + fake_key

    def setUp(self):
        config_patcher = patch.object(
            common_tool_impl, "get_config_value", return_value=self.fake_key
        )
        self.get_config = config_patcher.start()
        self.addCleanup(config_patcher.stop)
        request_patcher = patch.object(
            common_tool_impl.requests,
            "get",
            side_effect=AssertionError("Unexpected HTTP request"),
        )
        self.http_get = request_patcher.start()
        self.addCleanup(request_patcher.stop)

    def response(self, data):
        response = Mock()
        response.json.return_value = data
        return response

    def city_response(self):
        return self.response({"status": "1", "districts": [{"adcode": "510600"}]})

    def assert_tool_error(self, result, code):
        data = json.loads(result)
        self.assertEqual(set(data), {"ok", "data", "error"})
        self.assertIs(data["ok"], False)
        self.assertIsNone(data["data"])
        self.assertEqual(data["error"]["code"], code)
        self.assertIsInstance(data["error"]["message"], str)
        self.assertTrue(data["error"]["message"])
        self.assertNotIn(self.fake_key, result)
        self.assertNotIn(self.fake_url, result)
        self.assertNotIn("https://", result)

    def test_success_preserves_weather_json_and_uses_trimmed_city(self):
        lives = [{"city": "德阳市", "temperature": "20"}]
        self.http_get.side_effect = [
            self.city_response(), self.response({"status": "1", "lives": lives})
        ]
        result = json.loads(common_tool_impl.get_weather("  德阳  "))
        self.assertEqual(result, {"lives": lives, "forecasts": []})
        self.assertEqual(self.http_get.call_count, 2)
        self.assertEqual(self.http_get.call_args_list[0].kwargs["params"]["keywords"], "德阳")
        self.assertEqual(self.http_get.call_args_list[1].kwargs["params"]["city"], "510600")

    def test_missing_key_returns_structured_error_without_http(self):
        self.get_config.return_value = None
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_CONFIG_ERROR")
        self.http_get.assert_not_called()

    def test_blank_city_returns_structured_error_without_http(self):
        self.assert_tool_error(common_tool_impl.get_weather(" \t "), "INVALID_CITY")
        self.http_get.assert_not_called()

    def test_unknown_and_ambiguous_cities_do_not_request_weather(self):
        for districts in [[], [{"adcode": "510600"}, {"adcode": "510700"}]]:
            with self.subTest(districts=districts):
                self.http_get.reset_mock()
                self.http_get.side_effect = None
                self.http_get.return_value = self.response({"status": "1", "districts": districts})
                self.assert_tool_error(common_tool_impl.get_weather("同名城市"), "CITY_LOOKUP_FAILED")
                self.assertEqual(self.http_get.call_count, 1)

    def test_city_lookup_known_errors_do_not_expose_exception_text(self):
        for exception, code in [
            (ValueError(self.fake_url), "CITY_LOOKUP_FAILED"),
            (RuntimeError(self.fake_url), "CITY_SERVICE_ERROR"),
        ]:
            with self.subTest(exception=type(exception).__name__):
                with patch.object(common_tool_impl, "resolve_adcode", side_effect=exception):
                    self.assert_tool_error(common_tool_impl.get_weather("德阳"), code)
        self.http_get.assert_not_called()

    def test_city_timeout_becomes_safe_tool_error(self):
        self.http_get.side_effect = requests.Timeout(self.fake_url)
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_TIMEOUT")

    def test_city_network_and_http_errors_become_safe_tool_errors(self):
        self.http_get.side_effect = requests.ConnectionError(self.fake_url)
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_REQUEST_FAILED")
        response = self.city_response()
        response.raise_for_status.side_effect = requests.HTTPError(self.fake_url)
        self.http_get.side_effect = None
        self.http_get.return_value = response
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_REQUEST_FAILED")

    def test_city_invalid_json_becomes_safe_tool_error(self):
        response = self.city_response()
        response.json.side_effect = ValueError(self.fake_url)
        self.http_get.side_effect = None
        self.http_get.return_value = response
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "CITY_SERVICE_ERROR")

    def test_city_invalid_responses_become_safe_tool_errors(self):
        for data in [
            None,
            [],
            {"status": "0", "info": self.fake_url, "infocode": self.fake_key},
            {"status": "1"},
            {"status": "1", "districts": {}},
            {"status": "1", "districts": [None]},
            {"status": "1", "districts": [{}]},
            {"status": "1", "districts": [{"adcode": ""}]},
            {"status": "1", "districts": [{"adcode": 510600}]},
        ]:
            with self.subTest(data=data):
                self.http_get.side_effect = None
                self.http_get.return_value = self.response(data)
                self.assert_tool_error(common_tool_impl.get_weather("德阳"), "CITY_SERVICE_ERROR")

    def test_weather_timeout_becomes_safe_tool_error(self):
        self.http_get.side_effect = [self.city_response(), requests.Timeout(self.fake_url)]
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_TIMEOUT")

    def test_weather_network_and_http_errors_become_safe_tool_errors(self):
        self.http_get.side_effect = [self.city_response(), requests.ConnectionError(self.fake_url)]
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_REQUEST_FAILED")
        response = self.response({})
        response.raise_for_status.side_effect = requests.HTTPError(self.fake_url)
        self.http_get.side_effect = [self.city_response(), response]
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_REQUEST_FAILED")

    def test_weather_invalid_json_becomes_safe_tool_error(self):
        response = self.response({})
        response.json.side_effect = ValueError(self.fake_url)
        self.http_get.side_effect = [self.city_response(), response]
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_RESPONSE_INVALID")

    def test_weather_service_error_does_not_expose_provider_info(self):
        self.http_get.side_effect = [
            self.city_response(),
            self.response({"status": "0", "info": self.fake_url, "infocode": self.fake_key}),
        ]
        self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_SERVICE_ERROR")

    def test_weather_invalid_shapes_become_safe_tool_errors(self):
        for data in [
            None,
            [],
            {},
            {"status": "1"},
            {"status": "1", "lives": {}},
            {"status": "1", "lives": None},
            {"status": "1", "lives": ["invalid"]},
            {"status": "1", "forecasts": None},
            {"status": "1", "forecasts": [None]},
        ]:
            with self.subTest(data=data):
                self.http_get.side_effect = [self.city_response(), self.response(data)]
                self.assert_tool_error(common_tool_impl.get_weather("德阳"), "WEATHER_RESPONSE_INVALID")

    def test_forecast_only_response_preserves_success_contract(self):
        forecasts = [{"city": "德阳市", "casts": []}]
        self.http_get.side_effect = [
            self.city_response(), self.response({"status": "1", "forecasts": forecasts})
        ]
        self.assertEqual(
            json.loads(common_tool_impl.get_weather("德阳")),
            {"lives": [], "forecasts": forecasts},
        )


if __name__ == "__main__":
    unittest.main()
