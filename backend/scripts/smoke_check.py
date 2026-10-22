#!/usr/bin/env python3
"""End-to-end smoke check for a RUNNING Palantir API (standard library only).

    python scripts/smoke_check.py                              # http://localhost:8000
    python scripts/smoke_check.py --base-url http://localhost:8000
    docker compose exec backend python scripts/smoke_check.py  # from inside the container

Registers two throw-away users (random e-mails), then exercises authentication, role
checks, organizer profiles and events. Exits with code 1 if any check fails.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

PASSWORD = "Smoke-Test-Pass1"
failures = 0


def call(base_url, method, path, body=None, token=None, form=None):
    """Return (status_code, parsed_json_or_text)."""
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as error:
        raw, status = error.read(), error.code

    try:
        payload = json.loads(raw) if raw else None
    except ValueError:
        payload = raw.decode("utf-8", errors="replace")
    return status, payload


def check(name, condition, detail=""):
    global failures
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + ("" if condition else f"  -> {detail}"))
    if not condition:
        failures += 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://localhost:8000")
    base = parser.parse_args().base_url.rstrip("/")

    def api(method, path, **kwargs):
        return call(base, method, path, **kwargs)

    run_id = uuid.uuid4().hex[:8]
    organizer_email = f"smoke-org-{run_id}@example.com"
    attendee_email = f"smoke-att-{run_id}@example.com"

    try:
        status, body = api("GET", "/health")
    except urllib.error.URLError as error:
        print(f"Could not reach the API at {base}: {error.reason}")
        return 2
    check("health: API and database are up", status == 200 and body == {"status": "ok", "database": "up"}, (status, body))

    # --- registration
    status, body = api("POST", "/auth/register", body={"email": organizer_email, "full_name": "Smoke Organizer", "password": PASSWORD, "role": "organizer"})
    check("register organizer -> 201", status == 201 and body.get("role") == "organizer", (status, body))
    status, body = api("POST", "/auth/register", body={"email": organizer_email, "full_name": "Smoke Organizer", "password": PASSWORD, "role": "organizer"})
    check("duplicate registration -> 409", status == 409, (status, body))
    status, body = api("POST", "/auth/register", body={"email": attendee_email, "full_name": "Smoke Attendee", "password": PASSWORD})
    check("register attendee (default role) -> 201", status == 201 and body.get("role") == "attendee", (status, body))
    status, body = api("POST", "/auth/register", body={"email": f"x-{run_id}@example.com", "full_name": "Sneaky", "password": PASSWORD, "role": "admin"})
    check("self-registering as admin is refused -> 422", status == 422, (status, body))

    # --- login / tokens
    status, body = api("POST", "/auth/login", body={"email": organizer_email, "password": "wrong-password"})
    check("login with wrong password -> 401", status == 401, (status, body))
    status, tokens = api("POST", "/auth/login", body={"email": organizer_email, "password": PASSWORD})
    check("organizer login -> token pair", status == 200 and "access_token" in tokens and "refresh_token" in tokens, (status, tokens))
    if status != 200:
        print("Cannot continue without a token.")
        return 1
    org_token = tokens["access_token"]

    status, body = api("POST", "/auth/token", form={"username": organizer_email, "password": PASSWORD})
    check("OAuth2 form login (/auth/token) -> 200", status == 200 and "access_token" in body, (status, body))
    status, body = api("GET", "/auth/me", token=org_token)
    check("GET /auth/me -> organizer", status == 200 and body.get("email") == organizer_email and body.get("role") == "organizer", (status, body))
    status, body = api("GET", "/auth/me")
    check("GET /auth/me without token -> 401", status == 401, (status, body))
    status, refreshed = api("POST", "/auth/refresh", body={"refresh_token": tokens["refresh_token"]})
    check("refresh token -> new token pair", status == 200 and "access_token" in refreshed, (status, refreshed))
    status, body = api("POST", "/auth/refresh", body={"refresh_token": org_token})
    check("access token is refused as a refresh token -> 401", status == 401, (status, body))

    status, att_tokens = api("POST", "/auth/login", body={"email": attendee_email, "password": PASSWORD})
    att_token = att_tokens.get("access_token") if status == 200 else None
    check("attendee login -> 200", att_token is not None, (status, att_tokens))

    # --- role-based access control
    event_body = {
        "title": "Smoke Test Event",
        "description": "Created by scripts/smoke_check.py",
        "date": (datetime.now(timezone.utc) + timedelta(days=30)).replace(microsecond=0).isoformat(),
        "location": "Astana",
        "capacity": 100,
    }
    status, body = api("POST", "/events", body=event_body, token=att_token)
    check("attendee cannot create an event -> 403", status == 403, (status, body))
    status, body = api("POST", "/events", body=event_body)
    check("anonymous cannot create an event -> 401", status == 401, (status, body))

    # --- organizer profile
    profile = {"organization_name": "Smoke Club", "contact_email": f"club-{run_id}@example.com", "contact_phone": "+7 701 123 45 67"}
    status, created_profile = api("POST", "/organizer-profiles", body=profile, token=org_token)
    check("organizer creates profile -> 201", status == 201 and created_profile.get("organization_name") == "Smoke Club", (status, created_profile))
    status, body = api("POST", "/organizer-profiles", body=profile, token=org_token)
    check("second profile -> 409", status == 409, (status, body))
    status, body = api("GET", "/organizer-profiles/me", token=org_token)
    check("view own profile -> 200", status == 200 and body.get("organization_name") == "Smoke Club", (status, body))
    status, body = api("PUT", "/organizer-profiles/me", body={"organization_name": "Smoke Club 2"}, token=org_token)
    check("update profile -> 200", status == 200 and body.get("organization_name") == "Smoke Club 2", (status, body))
    if created_profile and "id" in created_profile and att_token:
        status, body = api("GET", f"/organizer-profiles/{created_profile['id']}", token=att_token)
        check("attendee can view a profile by id -> 200", status == 200, (status, body))

    # --- events
    status, event = api("POST", "/events", body=event_body, token=org_token)
    check("organizer creates event -> 201", status == 201 and event.get("capacity") == 100, (status, event))
    if status != 201:
        return 1
    status, body = api("PUT", f"/events/{event['id']}", body={"capacity": 250, "title": "Smoke Test Event (edited)"}, token=org_token)
    check("organizer edits event -> 200", status == 200 and body.get("capacity") == 250, (status, body))
    status, body = api("GET", f"/events/{event['id']}", token=org_token)
    check("edit was persisted", status == 200 and body.get("title") == "Smoke Test Event (edited)", (status, body))
    status, body = api("PATCH", f"/events/{event['id']}", body={"title": "Hijacked"}, token=att_token)
    check("attendee cannot edit the event -> 403", status == 403, (status, body))
    status, body = api("POST", "/events", body={**event_body, "capacity": 0}, token=org_token)
    check("capacity 0 is rejected -> 422", status == 422, (status, body))

    print()
    if failures:
        print(f"{failures} check(s) FAILED")
        return 1
    print("All smoke checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
