"""Run the existing real HTTP regression suite against the patched dashboard."""
import importlib
import os
from pathlib import Path
import sys
import unittest

source = Path(os.environ["BAIGUO_SOURCE"]).resolve()
bundle = Path(os.environ["BAIGUO_BUNDLE"]).resolve()
sys.path[:0] = [str(bundle), str(source), str(source / "tests")]


class EmbedHTTPTests(importlib.import_module("test_dashboard").DashboardHTTPTests):
    def test_only_explicit_embed_documents_allow_the_main_origin(self):
        for path in ("/?embed=dufesh", "/index.html?embed=dufesh"):
            response = self.get(path)
            self.assertEqual(200, response.status_code)
            self.assertNotIn("X-Frame-Options", response.headers)
            self.assertIn("frame-ancestors https://dufesh.cn;", response.headers["Content-Security-Policy"])
            self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        for path in ("/?embed=other", "/?embed=dufesh&embed=other", "/api/dashboard?embed=dufesh", "/api/session?embed=dufesh", "/healthz?embed=dufesh"):
            response = self.get(path)
            self.assertEqual("DENY", response.headers["X-Frame-Options"])
            self.assertIn("frame-ancestors 'none';", response.headers["Content-Security-Policy"])

    def test_embedding_does_not_grant_a_session_or_allow_main_origin_writes(self):
        self.get("/?embed=dufesh")
        self.assertEqual(401, self.get("/api/dashboard").status_code)
        self.assertEqual(403, self.post("/api/login", {"password": "synthetic"}, headers={"Origin": "https://dufesh.cn"}).status_code)


if __name__ == "__main__":
    unittest.main()
