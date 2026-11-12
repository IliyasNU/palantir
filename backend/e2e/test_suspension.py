"""Admin suspension and the action history over HTTP with a real PostgreSQL database."""
import uuid

import pytest
from sqlalchemy import text

from e2e.conftest import run_concurrently
from e2e.test_attendance import register_named
from e2e.test_concurrency import codes

REASON = {"reason": "Reported as fraudulent"}


@pytest.fixture()
def admin(register, db_engine):
    """Admins cannot register through the API: promote a fresh account in the database, as create_admin does."""
    user = register()
    with db_engine.begin() as connection:
        connection.execute(
            text("UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'admin') WHERE id = :id"),
            {"id": user.id},
        )
    return user


def test_suspension_racing_parallel_claims_never_issues_a_ticket_afterwards(
    api, register, published_event, admin, sql
):
    owner = register("organizer")
    event_id = published_event(owner, capacity=50)["id"]
    root = f"/events/{event_id}"
    attendees = [register() for _ in range(12)]

    calls = [lambda client, a=attendee: client.post(f"{root}/tickets", headers=a.headers) for attendee in attendees]
    calls.insert(6, lambda client: client.post(f"/admin{root}/suspend", json=REASON, headers=admin.headers))
    results = run_concurrently(calls)
    suspend, claims = results[6], results[:6] + results[7:]
    assert suspend.status_code == 200, suspend.text

    # A claim either won a seat before the suspension, never saw the event (404), or lost the race for the row (409).
    outcome = codes(claims)
    assert set(outcome) <= {201, "EVENT_NOT_FOUND", "EVENT_SUSPENDED"}, outcome
    issued = outcome[201]
    assert sql("SELECT tickets_issued FROM events WHERE id = :id", id=event_id) == issued
    assert sql("SELECT count(*) FROM tickets WHERE event_id = :id", id=event_id) == issued
    assert sql("SELECT coalesce(sum(tickets_issued), 0) FROM ticket_types WHERE event_id = :id", id=event_id) == issued
    # The suspension waited for the claims in flight, so no ticket is newer than it.
    assert sql(
        "SELECT count(*) FROM tickets t JOIN events e ON e.id = t.event_id "
        "WHERE e.id = :id AND t.created_at > e.suspended_at",
        id=event_id,
    ) == 0

    late = register()
    refused = api.post(f"{root}/tickets", headers=late.headers)
    assert refused.status_code == 404 and refused.json()["detail"]["code"] == "EVENT_NOT_FOUND"
    assert event_id not in [row["id"] for row in api.get("/events").json()]
    assert sql("SELECT count(*) FROM tickets WHERE event_id = :id", id=event_id) == issued

    assert api.post(f"/admin{root}/reactivate", headers=admin.headers).status_code == 200
    assert api.post(f"{root}/tickets", headers=late.headers).status_code == 201
    assert event_id in [row["id"] for row in api.get("/events").json()]
    assert sql(
        "SELECT count(*) FROM action_logs WHERE event_id = :id AND action = 'event.suspended'", id=event_id
    ) == 1


def test_parallel_suspensions_record_one_action(api, register, published_event, admin, sql):
    owner = register("organizer")
    event_id = published_event(owner)["id"]
    path = f"/admin/events/{event_id}/suspend"
    results = run_concurrently([lambda client: client.post(path, json=REASON, headers=admin.headers)] * 5)
    assert codes(results) == {200: 5}
    assert len({result.json()["suspended_at"] for result in results}) == 1
    assert sql(
        "SELECT count(*) FROM action_logs WHERE event_id = :id AND action = 'event.suspended'", id=event_id
    ) == 1


def test_history_matches_admissions_after_parallel_scans(api, register, published_event, sql):
    """Check-in writes its history entry in the same transaction: a lost race leaves no orphan entry."""
    owner = register("organizer")
    event_id = published_event(owner)["id"]
    tickets = []
    for _ in range(4):
        response = api.post(f"/events/{event_id}/tickets", headers=register().headers)
        assert response.status_code == 201, response.text
        tickets.append(response.json())

    def scan(client, qr_payload):
        body = {"qr_payload": qr_payload, "request_id": str(uuid.uuid4())}
        return client.post(f"/events/{event_id}/check-in", json=body, headers=owner.headers)

    results = run_concurrently(
        [lambda client, qr=ticket["qr_payload"]: scan(client, qr) for ticket in tickets for _ in range(3)]
    )
    assert codes(results) == {200: 4, "ALREADY_CHECKED_IN": 8}
    assert sql("SELECT count(*) FROM check_ins WHERE event_id = :id", id=event_id) == 4
    assert sql(
        "SELECT count(*) FROM action_logs l JOIN check_ins c ON c.id = l.entity_id "
        "WHERE l.event_id = :id AND l.action = 'check_in.created' AND c.event_id = :id",
        id=event_id,
    ) == 4
    assert sql(
        "SELECT count(*) FROM action_logs WHERE event_id = :id AND action = 'check_in.created'", id=event_id
    ) == 4

    timeline = api.get(f"/events/{event_id}/action-log", params={"action": "check_in"}, headers=owner.headers).json()
    assert len(timeline) == 4 and {entry["actor_id"] for entry in timeline} == {owner.id}


def test_user_suspension_blocks_the_account_and_is_recorded_as_a_platform_action(api, admin, sql):
    marker = uuid.uuid4().hex[:6]
    target = register_named(api, f"Әлия Жұмабаева {marker}")
    target_id = api.get("/auth/me", headers=target.headers).json()["id"]

    # Case-insensitive search of a Kazakh name needs the database's ICU locale.
    found = api.get("/admin/users", params={"q": f"ӘЛИЯ ЖҰМАБАЕВА {marker}".upper()}, headers=admin.headers).json()
    assert [user["id"] for user in found] == [target_id]

    suspended = api.post(f"/admin/users/{target_id}/suspend", json=REASON, headers=admin.headers)
    assert suspended.status_code == 200 and suspended.json()["is_active"] is False
    assert api.get("/auth/me", headers=target.headers).status_code == 403
    assert sql(
        "SELECT count(*) FROM action_logs WHERE event_id IS NULL AND action = 'user.suspended' "
        "AND entity_id = :id AND actor_id = :admin",
        id=target_id, admin=admin.id,
    ) == 1
    newest = api.get("/admin/action-log", params={"action": "user.suspended", "limit": 1}, headers=admin.headers).json()
    assert (newest[0]["event_id"], newest[0]["entity_id"]) == (None, target_id)

    assert api.post(f"/admin/users/{target_id}/reactivate", headers=admin.headers).json()["is_active"] is True
    assert api.get("/auth/me", headers=target.headers).status_code == 200
