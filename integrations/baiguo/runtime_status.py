"""Bounded, allowlisted account and attendance history for the private dashboard."""
from datetime import datetime, timezone
import hashlib
import json
import math

from dashboard_state import public_status as base_status, public_actions, timestamp

STATES = {"disabled", "idle", "waiting", "running", "success", "failed", "needs_manual_login", "unavailable", "cooldown", "closed", "interrupted"}
REASONS = {"not_started", "login_required", "timeout", "invalid_result", "renewed", "helper_failed", "settling_after_rejection", "cancelled", "state_missing", "state_unreadable", "invalid_state", "retry_later", "launch_failed", "renewing", "stopped", "service_restarted"}
KINDS = {"auth_rejected", "auth_verified", "renew_queued", "renew_started", "renew_success", "renew_failed", "renew_manual", "renew_unavailable", "renew_interrupted", "attendance"}
TERMINAL = {"success": "renew_success", "failed": "renew_failed", "needs_manual_login": "renew_manual", "unavailable": "renew_unavailable"}
LIMIT = 100


def choice(value, allowed, default=None):
    return value if isinstance(value, str) and value in allowed else default


def moment(value):
    if type(value) in (int, float) and math.isfinite(value) and 946684800 <= value <= 4102444800:
        return datetime.fromtimestamp(value, timezone.utc).isoformat()
    return timestamp(value)


def renewal(value):
    value = value if isinstance(value, dict) else {}
    return {
        "status": choice(value.get("status"), STATES, "unavailable"),
        "reason": choice(value.get("reason"), REASONS),
        **{key: moment(value.get(key)) for key in ("last_attempt", "next_attempt", "pending_at", "last_result_at")},
        "last_result": choice(value.get("last_result"), STATES),
    }


def public_status(value):
    value = value if isinstance(value, dict) else {}
    return {**base_status(value), "last_auth_rejected_at": timestamp(value.get("last_auth_rejected_at")),
            "session_renewal": renewal(value.get("session_renewal"))}


def public_events(value):
    if not isinstance(value, list):
        return []
    events = {}
    for item in value[:300]:
        if not isinstance(item, dict) or not choice(item.get("kind"), KINDS) or not timestamp(item.get("at")):
            continue
        event = {"kind": item["kind"], "at": item["at"]}
        if item["kind"] == "attendance":
            actions = public_actions([dict(item, updated_at=item["at"])])
            if not actions:
                continue
            event.update({key: actions[0][key] for key in ("activity_id", "status")})
        event["id"] = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()[:24]
        events[event["id"]] = event
    return sorted(events.values(), key=lambda event: datetime.fromisoformat(event["at"]).timestamp(), reverse=True)[:LIMIT]


def read_json(path, default):
    try:
        # A corrupt or unexpectedly large mirror cannot consume unlimited memory.
        if path.stat().st_size > 256 * 1024:
            return default
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def publish_health(path, raw, write):
    """Called by Recorder under its existing lock; never makes school requests."""
    previous = public_status(read_json(path, {}))
    current = public_status(raw)
    events_path = path.with_name("runtime-events.json")
    events = public_events(read_json(events_path, []))
    before = list(events)
    at = current["updated_at"]

    def add(kind, when):
        if when:
            events.append({"kind": kind, "at": when})

    auth = current.get("authentication_state")
    if auth == "auth_required" and previous.get("authentication_state") != auth:
        add("auth_rejected", current["last_auth_rejected_at"])
    if auth == "authenticated" and previous.get("authentication_state") != auth:
        add("auth_verified", current["last_auth_accepted_at"])
    # A fresh history can also retain the last known rejection from before enablement.
    if not before:
        add("auth_rejected", current["last_auth_rejected_at"])
        add("auth_verified", current["last_auth_accepted_at"])
    old, new = previous["session_renewal"], current["session_renewal"]
    actual_attempt = new["last_attempt"]
    if actual_attempt and actual_attempt != old["last_attempt"]:
        add("renew_started", actual_attempt)
    if new["status"] == "waiting" and (new["status"], new["pending_at"]) != (old["status"], old["pending_at"]):
        add("renew_queued", at)
    if new["status"] in TERMINAL and (new["status"], actual_attempt or old["last_attempt"], new["reason"]) != (old["status"], old["last_attempt"], old["reason"]):
        add(TERMINAL[new["status"]], at)
        new["last_result"], new["last_result_at"] = new["status"], at
    elif new["status"] == "idle" and old["status"] == "running" and not actual_attempt:
        add("renew_interrupted", at)
        new["last_result"], new["last_result_at"] = "interrupted", at
    else:
        new["last_result"], new["last_result_at"] = old["last_result"], old["last_result_at"]
    if not actual_attempt:
        new["last_attempt"] = old["last_attempt"]
    for action in public_actions(read_json(path.with_name("actions.json"), [])):
        if action["updated_at"]:
            events.append({"kind": "attendance", "at": action["updated_at"], "activity_id": action["activity_id"], "status": action["status"]})
    events = public_events(events)
    write(path, current)
    if events != before or not events_path.exists():
        write(events_path, events)
