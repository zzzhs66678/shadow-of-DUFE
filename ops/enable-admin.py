"""Enable administrator MFA configuration without printing or rotating secrets.

Run on the release host: python3 enable-admin.py /absolute/path/auth.env
Account enrollment remains the separate interactive admin:bootstrap command.
"""
import base64
import datetime
import json
import os
from pathlib import Path
import secrets
import sys


def main():
    target = Path(sys.argv[1]).resolve(strict=True)
    if target.name != "auth.env" or not target.is_file():
        raise SystemExit("Expected an existing auth.env file")
    original = target.read_text()
    lines = original.splitlines()
    values = {}
    for line in lines:
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    if values.get("AUTH_ADMIN_ENABLED") == "true":
        raise SystemExit("Administrator service already enabled; no changes made")
    keys = json.loads(values.get("AUTH_ADMIN_MFA_KEYS") or "{}")
    key_id = values.get("AUTH_ADMIN_MFA_ACTIVE_KEY_ID") or "admin-2026-09"
    if keys and key_id not in keys:
        raise SystemExit("Existing MFA keyring needs manual inspection; unchanged")
    if not keys:
        keys[key_id] = base64.b64encode(secrets.token_bytes(32)).decode()
    for value in keys.values():
        if len(base64.b64decode(value, validate=True)) != 32:
            raise SystemExit("Invalid existing MFA key; unchanged")
    pepper = values.get("AUTH_ADMIN_RECOVERY_PEPPER") or secrets.token_hex(32)
    if len(pepper) < 32:
        raise SystemExit("Existing recovery pepper too short; unchanged")
    updates = {
        "AUTH_ADMIN_ENABLED": "true",
        "AUTH_ADMIN_MFA_ACTIVE_KEY_ID": key_id,
        "AUTH_ADMIN_MFA_KEYS": "'" + json.dumps(keys, separators=(",", ":")) + "'",
        "AUTH_ADMIN_RECOVERY_PEPPER": pepper,
    }
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = target.with_name("auth.env.before-admin-" + stamp)
    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(original)
    result = [line for line in lines if line.split("=", 1)[0].strip() not in updates]
    result.extend(key + "=" + value for key, value in updates.items())
    temporary = target.with_name("auth.env.admin-" + secrets.token_hex(8))
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write("\n".join(result) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    print("Administrator configuration enabled; private 0600 backup retained. No secrets printed.")


if __name__ == "__main__":
    main()
