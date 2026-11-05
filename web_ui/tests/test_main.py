import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from src.service.web_server import app as backend_app
from web_ui.main import app


class WebUiIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_file_entry_starts_with_only_script_directory_on_search_path(self):
        entry = Path(__file__).resolve().parent.parent / "main.py"
        code = """
import runpy
import sys
from pathlib import Path
from unittest.mock import patch

entry = Path(sys.argv[1])
sys.path.insert(0, str(entry.parent))
with patch('uvicorn.run') as run:
    namespace = runpy.run_path(str(entry), run_name='__main__')
run.assert_called_once_with(namespace['app'], host='127.0.0.1', port=6576)
"""
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", code, str(entry)],
            cwd=entry.parent,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_page_and_assets_are_served(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers["content-type"])
        self.assertIn("Teresa", response.text)
        self.assertEqual(self.client.get("/api.js").status_code, 200)
        avatar = self.client.get("/assets/teresa.png")
        self.assertEqual(avatar.status_code, 200)
        self.assertIn("image/png", avatar.headers["content-type"])
        self.assertTrue(avatar.content.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_existing_health_route_is_not_hidden_by_static_files(self):
        self.assertIs(app, backend_app)
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    @patch("src.service.web_server.invoke", return_value="你好，我是特蕾莎。")
    def test_content_request_uses_backend_role_and_json_string_response(self, invoke):
        response = self.client.post("/api/chat", json={"content": "你好"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), "你好，我是特蕾莎。")
        invoke.assert_called_once_with({"role": "user", "content": "你好"})

    @patch("src.service.web_server.invoke")
    def test_old_history_request_is_rejected_without_calling_model(self, invoke):
        response = self.client.post("/api/chat", json={
            "messages": [{"role": "user", "content": "你好"}],
        })
        self.assertEqual(response.status_code, 422)
        invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main()
