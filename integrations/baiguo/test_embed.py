"""Run the existing real HTTP regression suite against the patched dashboard."""
import importlib
import os
from pathlib import Path
import sys
import unittest
import json
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

source = Path(os.environ["BAIGUO_SOURCE"]).resolve()
bundle = Path(os.environ["BAIGUO_BUNDLE"]).resolve()
sys.path[:0] = [str(bundle), str(source), str(source / "tests")]


class EmbedHTTPTests(importlib.import_module("test_dashboard").DashboardHTTPTests):
    def test_handoff_issues_only_a_short_lived_single_use_ticket(self):
        password = importlib.import_module("test_dashboard").PASSWORD
        response = self.post("/api/handoff", {"password": password, "expires_at": time.time() + 20})
        self.assertEqual(200, response.status_code)
        self.assertNotIn("Set-Cookie", response.headers)
        self.assertEqual({"ticket"}, set(response.json()))
        self.assertFalse(self.get("/api/session").json()["authenticated"])
        ticket = response.json()["ticket"]
        connected = self.post("/api/handoff/exchange", {"ticket": ticket})
        self.assertEqual(200, connected.status_code)
        self.assertTrue(connected.json()["authenticated"])
        self.assertIn("HttpOnly", connected.headers["Set-Cookie"])
        self.assertEqual(401, self.post("/api/handoff/exchange", {"ticket": ticket}).status_code)
        self.assertTrue(self.get("/api/session").json()["authenticated"])

    def test_handoff_expiry_and_origin_are_enforced(self):
        password = importlib.import_module("test_dashboard").PASSWORD
        self.assertEqual(403, self.post("/api/handoff", {"password": password, "expires_at": time.time() + 20}, headers={"Origin": "https://outside.example"}).status_code)
        self.assertEqual(401, self.post("/api/handoff", {"password": password, "expires_at": time.time() - 1}).status_code)
        self.assertEqual(401, self.post("/api/handoff/exchange", {"ticket": "A" * 43}).status_code)
        self.assertEqual(401, self.post("/api/handoff", {"password": "synthetic-wrong-password", "expires_at": time.time() + 20}).status_code)

    def test_handoff_consumption_is_atomic_and_expired_tickets_fail(self):
        password = importlib.import_module("test_dashboard").PASSWORD
        sessions = self.server.app.sessions
        ticket, _ = sessions.authenticate(password, "synthetic-ip", handoff_until=time.time() + 20)
        def exchange(_):
            try:
                sessions.exchange_handoff(ticket)
                return 200
            except importlib.import_module("dashboard").ControlError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual([200, 401], sorted(pool.map(exchange, range(2))))
        expired, _ = sessions.authenticate(password, "synthetic-ip", handoff_until=time.time() + 20)
        with patch("dashboard.time.time", return_value=time.time() + 31):
            with self.assertRaises(importlib.import_module("dashboard").ControlError):
                sessions.exchange_handoff(expired)

    def test_runtime_history_is_private_and_allowlisted(self):
        self.assertEqual(401, self.get("/api/dashboard").status_code)
        self.login()
        status = json.loads(self.status_path.read_text(encoding="utf-8"))
        status.update(last_auth_rejected_at="2026-10-16T12:00:00+08:00", session_renewal={"status": "failed", "last_attempt": 1792119630, "token": "PRIVATE-RENEWAL"})
        self.status_path.write_text(json.dumps(status), encoding="utf-8")
        self.status_path.with_name("runtime-events.json").write_text(json.dumps([{"kind": "renew_failed", "at": "2026-10-16T12:01:00+08:00", "password": "PRIVATE-HISTORY"}]), encoding="utf-8")
        response = self.get("/api/dashboard")
        self.assertEqual("failed", response.json()["session_renewal"]["status"])
        self.assertEqual("renew_failed", response.json()["runtime_events"][0]["kind"])
        self.assertNotIn("PRIVATE", response.text)

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
