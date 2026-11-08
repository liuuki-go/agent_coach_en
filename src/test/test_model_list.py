import asyncio
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.router import web_server


class ModelListTests(unittest.TestCase):
    def setUp(self):
        self.catalog = {
            "default": "second-model",
            "models": [
                {"name": "first-model", "display_name": "First model"},
                {"name": "second-model", "display_name": "Second model"},
            ],
        }
        patcher = patch.object(web_server.app.state, "model_list", self.catalog, create=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(web_server.app)
        self.addCleanup(self.client.close)

    def test_list_reads_the_startup_snapshot_without_constructing_or_switching_models(self):
        with (
            patch.object(web_server, "get_model_list") as read_config,
            patch.object(web_server, "build_agent") as build_agent,
        ):
            response = self.client.get("/api/models/getModelList?default=first-model")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.catalog)
        read_config.assert_not_called()
        build_agent.assert_not_called()

    def test_display_endpoint_does_not_accept_switch_requests(self):
        response = self.client.post("/api/models/getModelList", json={"default": "first-model"})
        self.assertEqual(response.status_code, 405)
        self.assertEqual(web_server.app.state.model_list["default"], "second-model")

    def test_lifespan_builds_agent_without_caller_model_parameters(self):
        application = FastAPI()
        pool = Mock()
        saver = Mock()
        store = Mock()
        agent = Mock()

        async def start_and_stop():
            async with web_server.lifespan(application):
                self.assertEqual(application.state.model_list, self.catalog)
                self.assertIs(application.state.agent, agent)

        with (
            patch("builtins.print"),
            patch.object(web_server, "get_model_list", return_value=self.catalog),
            patch.object(web_server, "create_db_pool", return_value=pool),
            patch.object(web_server, "PostgresSaver", return_value=saver),
            patch.object(web_server, "SessionStore", return_value=store),
            patch.object(web_server, "build_agent", return_value=agent) as build_agent,
        ):
            asyncio.run(start_and_stop())

        build_agent.assert_called_once_with(checkpointer=saver, tools=web_server.common_tools)
        pool.open.assert_called_once_with(wait=True, timeout=5)
        pool.close.assert_called_once()

    def test_invalid_model_config_fails_before_opening_database_resources(self):
        async def start():
            async with web_server.lifespan(FastAPI()):
                self.fail("Invalid model configuration should prevent startup")

        with (
            patch.object(web_server, "get_model_list", side_effect=ValueError("Invalid model_list")),
            patch.object(web_server, "create_db_pool") as create_pool,
            patch.object(web_server, "build_agent") as build_agent,
        ):
            with self.assertRaisesRegex(ValueError, "model_list"):
                asyncio.run(start())
        create_pool.assert_not_called()
        build_agent.assert_not_called()


if __name__ == "__main__":
    unittest.main()
