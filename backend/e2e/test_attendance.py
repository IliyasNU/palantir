"""Attendance totals and attendee search on PostgreSQL (SQLite's lower() only folds ASCII)."""
import uuid
from types import SimpleNamespace

from e2e.conftest import PASSWORD, run_concurrently


def register_named(api, full_name: str) -> SimpleNamespace:
    email = f"e2e-named-{uuid.uuid4().hex[:12]}@example.com"
    response = api.post(
        "/auth/register", json={"email": email, "full_name": full_name, "password": PASSWORD, "role": "attendee"}
    )
    assert response.status_code == 201, response.text
    tokens = api.post("/auth/login", json={"email": email, "password": PASSWORD}).json()
    return SimpleNamespace(email=email, headers={"Authorization": f"Bearer {tokens['access_token']}"})


def claim(api, event, attendee):
    response = api.post(f"/events/{event['id']}/tickets", headers=attendee.headers)
    assert response.status_code == 201, response.text
    return response.json()


def test_search_folds_cyrillic_case_and_feeds_check_in(api, register, published_event, sql):
    owner = register("organizer")
    event = published_event(owner)
    marker = uuid.uuid4().hex[:6]
    attendee = register_named(api, f"Әлия Жұмабаева {marker}")
    ticket = claim(api, event, attendee)

    for q in ("ӘЛИЯ", "жұмабаева", f"Әлия Жұмабаева {marker}".upper()):
        response = api.get(f"/events/{event['id']}/attendees", params={"q": q}, headers=owner.headers)
        assert response.status_code == 200, response.text
        assert [result["ticket_id"] for result in response.json()] == [ticket["id"]], q

    [found] = api.get(f"/events/{event['id']}/attendees", params={"q": marker}, headers=owner.headers).json()
    assert found["qr_payload"] == ticket["qr_payload"]
    assert found["masked_email"] == "e2***@example.com"
    body = {"qr_payload": found["qr_payload"], "request_id": str(uuid.uuid4())}
    assert api.post(f"/events/{event['id']}/check-in", json=body, headers=owner.headers).status_code == 200
    assert sql("SELECT count(*) FROM check_ins WHERE ticket_id = :id", id=ticket["id"]) == 1


def test_attendance_matches_the_database_after_parallel_scans(api, register, published_event, sql):
    owner = register("organizer")
    event = published_event(owner)
    tickets = [claim(api, event, register()) for _ in range(4)]

    before = api.get(f"/events/{event['id']}/attendance", headers=owner.headers).json()
    assert before == {"event_id": event["id"], "capacity": 100, "tickets_issued": 4, "checked_in": 0}

    # Two phones scan each ticket at once: exactly one admission per ticket.
    calls = [
        (lambda client, qr=ticket["qr_payload"]: client.post(
            f"/events/{event['id']}/check-in",
            json={"qr_payload": qr, "request_id": str(uuid.uuid4())},
            headers=owner.headers,
        ))
        for ticket in tickets
        for _ in range(2)
    ]
    statuses = sorted(response.status_code for response in run_concurrently(calls))
    assert statuses == [200] * 4 + [409] * 4

    after = api.get(f"/events/{event['id']}/attendance", headers=owner.headers).json()
    assert after["checked_in"] == 4
    assert after["checked_in"] == sql("SELECT count(*) FROM check_ins WHERE event_id = :id", id=event["id"])
