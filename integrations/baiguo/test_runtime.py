"""Synthetic runtime transitions; never contacts a school endpoint."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path[:0] = [os.environ["BAIGUO_BUNDLE"], os.environ["BAIGUO_SOURCE"]]
from diagnostics import Recorder
from runtime_status import public_status, public_events


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.status = self.root / "mirror/status.json"
        self.status.parent.mkdir()
        self.recorder = Recorder(self.root / "private")
        self.env = patch.dict(os.environ, {"DASHBOARD_STATUS_PATH": str(self.status)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def health(self, **values):
        self.recorder.health(**values)
        return json.loads(self.status.read_text())

    def events(self):
        return json.loads(self.status.with_name("runtime-events.json").read_text())

    def test_loss_renewal_and_verification_are_separate_persistent_events(self):
        attempt = 1792119630
        rejected = "2026-10-16T12:20:00+08:00"
        self.health(authentication_state="auth_required", last_auth_rejected_at=rejected,
                    authentication_signature=["PRIVATE-TOKEN"], session_renewal={"status": "waiting", "pending_at": attempt})
        self.health(authentication_state="auth_required", last_auth_rejected_at=rejected,
                    session_renewal={"status": "running", "last_attempt": attempt, "reason": "renewing"})
        result = self.health(authentication_state="auth_unverified", session_renewal={"status": "success", "last_attempt": attempt, "reason": "renewed", "token": "PRIVATE-TOKEN"})
        self.assertEqual("success", result["session_renewal"]["last_result"])
        self.assertNotIn("auth_verified", [e["kind"] for e in self.events()])
        for number in range(20):
            self.health(authentication_state="authenticated", last_auth_accepted_at=f"2026-10-16T12:22:{number:02d}+08:00",
                        session_renewal={"status": "success", "last_attempt": attempt, "reason": "renewed"})
        kinds = [e["kind"] for e in self.events()]
        for kind in ["auth_rejected", "renew_queued", "renew_started", "renew_success", "auth_verified"]:
            self.assertEqual(1, kinds.count(kind), kind)
        before = self.events()
        self.recorder = Recorder(self.root / "private")
        result = self.health(authentication_state="authenticated", last_auth_accepted_at="2026-10-16T12:23:00+08:00", session_renewal={"status": "idle"})
        self.assertEqual(before, self.events())
        self.assertIsNotNone(result["session_renewal"]["last_attempt"])
        self.assertEqual("success", result["session_renewal"]["last_result"])
        self.assertNotIn("PRIVATE", self.status.read_text() + json.dumps(self.events()))

    def test_pending_and_query_confirmation_preserve_their_own_times_and_results(self):
        for result in ["pending_confirmation", "confirmed", "observed_signed"]:
            self.recorder.record(event="attendance_result", activity_id="123", result=result, token="PRIVATE-TOKEN")
        self.health(phase="waiting")
        self.assertEqual({"pending_confirmation", "confirmed", "observed_signed"}, {e["status"] for e in self.events()})
        self.assertTrue(all(e["at"] and e["activity_id"] == "123" for e in self.events()))
        before = self.events()
        self.health(phase="waiting")
        self.assertEqual(before, self.events())

    def test_restart_does_not_claim_an_old_running_attempt_is_still_running(self):
        self.health(session_renewal={"status": "running", "last_attempt": 1792119630})
        result = self.health(session_renewal={"status": "idle"})
        self.assertEqual("idle", result["session_renewal"]["status"])
        self.assertEqual("interrupted", result["session_renewal"]["last_result"])
        self.assertIn("renew_interrupted", [e["kind"] for e in self.events()])

    def test_failed_before_launch_is_not_repeated_on_each_poll(self):
        self.health(session_renewal={"status": "success", "last_attempt": 1792119630})
        for _ in range(10):
            self.health(session_renewal={"status": "unavailable", "reason": "state_missing"})
        self.assertEqual(1, [e["kind"] for e in self.events()].count("renew_unavailable"))

    def test_malformed_and_sensitive_values_cannot_enter_public_projection(self):
        for value in [None, [], {"session_renewal": {"status": [], "reason": {}, "last_attempt": True, "pending_at": float("inf")}},
                      {"session_renewal": {"status": "failed", "reason": "https://private/?token=secret", "token": "secret"}}]:
            result = public_status(value)
            self.assertNotIn("secret", json.dumps(result))
        self.assertEqual([], public_events([{"kind": [], "at": "2026-10-16T12:00:00+08:00"}, {"kind": "auth_verified", "at": "invalid"}]))

    def test_history_is_bounded_sorted_and_resanitized(self):
        events = [{"kind": "attendance", "at": f"2026-10-16T12:{i // 60:02d}:{i % 60:02d}+08:00", "activity_id": str(i), "status": "confirmed", "password": "SECRET"} for i in range(150)]
        public = public_events(events)
        self.assertEqual(100, len(public))
        self.assertEqual("149", public[0]["activity_id"])
        self.assertNotIn("SECRET", json.dumps(public))
        self.status.with_name("runtime-events.json").write_text("invalid")
        self.health(authentication_state="auth_required", last_auth_rejected_at="2026-10-16T12:00:00+08:00")
        self.assertEqual("auth_rejected", self.events()[0]["kind"])


if __name__ == "__main__":
    unittest.main()
