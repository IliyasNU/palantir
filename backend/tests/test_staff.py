"""Per-event staff assignment and the scanner's event list."""
import pytest
from sqlalchemy import delete
from sqlalchemy import event as sa_event
from sqlalchemy.orm import Session

from app.models import EventStaff

from tests.helpers import future_iso


def detail_code(response):
    return response.json()["detail"]["code"]


def assign(client, event_id, email, headers):
    return client.post(f"/events/{event_id}/staff", json={"email": email}, headers=headers)


@pytest.fixture()
def owner(login_as):
    return login_as("owner@example.com", "organizer")[1]


# ------------------------------------------------------------------ assignment
def test_owner_assigns_staff_by_email(client, login_as, owner, new_event):
    staff_user, _ = login_as("staff@example.com")
    event = new_event(owner)

    response = assign(client, event["id"], "  STAFF@Example.com ", owner)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["user_id"] == staff_user.id
    assert body["email"] == "staff@example.com"
    assert body["full_name"] == staff_user.full_name
    assert "created_at" in body

    again = assign(client, event["id"], "staff@example.com", owner)
    assert again.status_code == 200
    assert again.json() == body
    assert client.get(f"/events/{event['id']}/staff", headers=owner).json() == [body]


def test_unknown_or_invalid_email(client, owner, new_event):
    event = new_event(owner)
    response = assign(client, event["id"], "nobody@example.com", owner)
    assert response.status_code == 404
    assert detail_code(response) == "USER_NOT_FOUND"
    assert assign(client, event["id"], "not-an-email", owner).status_code == 422


def test_remove_staff_is_idempotent(client, login_as, owner, new_event):
    staff_user, _ = login_as("staff@example.com")
    event = new_event(owner)
    assign(client, event["id"], "staff@example.com", owner)

    for _ in range(2):
        response = client.delete(f"/events/{event['id']}/staff/{staff_user.id}", headers=owner)
        assert response.status_code == 204
    assert client.get(f"/events/{event['id']}/staff", headers=owner).json() == []


def test_only_owner_or_admin_manages_staff(client, login_as, owner, new_event):
    staff_user, staff = login_as("staff@example.com")
    _, other = login_as("other@example.com", "organizer")
    _, admin = login_as("admin@example.com", "admin")
    event = new_event(owner)
    assign(client, event["id"], "staff@example.com", owner)
    base = f"/events/{event['id']}/staff"

    for headers, expected in ((staff, 403), (other, 403), ({}, 401)):
        assert client.get(base, headers=headers).status_code == expected
        if expected == 403:
            assert detail_code(client.get(base, headers=headers)) == "FORBIDDEN"
        assert assign(client, event["id"], "staff@example.com", headers).status_code == expected
        assert client.delete(f"{base}/{staff_user.id}", headers=headers).status_code == expected

    assert client.get(base, headers=admin).status_code == 200
    assert client.delete(f"{base}/{staff_user.id}", headers=admin).status_code == 204
    assert assign(client, event["id"], "staff@example.com", admin).status_code == 201


def test_staff_endpoints_on_unknown_event_are_404(client, owner):
    assert client.get("/events/99999/staff", headers=owner).status_code == 404
    assert assign(client, 99999, "owner@example.com", owner).status_code == 404
    assert client.delete("/events/99999/staff/1", headers=owner).status_code == 404


# ------------------------------------------------------------------ GET /staff/events
def test_no_assignments_means_an_empty_list(client, login_as, owner, new_event):
    _, staff = login_as("staff@example.com")
    new_event(owner)
    response = client.get("/staff/events", headers=staff)
    assert response.status_code == 200
    assert response.json() == []


def test_staff_sees_assigned_published_events_only(client, login_as, owner, new_event):
    _, staff = login_as("staff@example.com")
    later = new_event(owner, date=future_iso(days=40))
    sooner = new_event(owner, date=future_iso(days=4))
    draft = new_event(owner, publish=False)
    cancelled = new_event(owner)
    new_event(owner)  # not assigned
    for event in (later, sooner, draft, cancelled):
        assign(client, event["id"], "staff@example.com", owner)
    client.post(f"/events/{cancelled['id']}/cancel", headers=owner)

    body = client.get("/staff/events", headers=staff).json()
    assert [event["id"] for event in body] == [sooner["id"], later["id"]]
    assert set(body[0]) == {"id", "title", "date", "location", "status", "can_manage"}
    assert [event["can_manage"] for event in body] == [False, False]


def test_removed_staff_loses_the_event(client, login_as, owner, new_event):
    staff_user, staff = login_as("staff@example.com")
    event = new_event(owner)
    assign(client, event["id"], "staff@example.com", owner)
    assert len(client.get("/staff/events", headers=staff).json()) == 1
    client.delete(f"/events/{event['id']}/staff/{staff_user.id}", headers=owner)
    assert client.get("/staff/events", headers=staff).json() == []


def test_owner_sees_own_events_and_admin_sees_all(client, login_as, owner, new_event):
    _, other = login_as("other@example.com", "organizer")
    _, admin = login_as("admin@example.com", "admin")
    mine = new_event(owner)
    theirs = new_event(other)
    new_event(other, publish=False)

    assert [event["id"] for event in client.get("/staff/events", headers=owner).json()] == [mine["id"]]
    assert {event["id"] for event in client.get("/staff/events", headers=admin).json()} == {mine["id"], theirs["id"]}


def test_staff_events_needs_login(client):
    assert client.get("/staff/events").status_code == 401


def test_assignment_answers_even_if_revoked_right_after_commit(client, login_as, owner, new_event, session_factory):
    """Race found in review: a revoke landing between the assignment commit and its response."""
    staff_user, _ = login_as("staff@example.com")
    event = new_event(owner)

    fired = []

    def revoke_once(session):
        if fired:
            return
        fired.append(True)
        with session_factory() as other:
            other.execute(delete(EventStaff).where(EventStaff.user_id == staff_user.id))
            other.commit()

    sa_event.listen(Session, "after_commit", revoke_once)
    try:
        response = assign(client, event["id"], "staff@example.com", owner)
    finally:
        sa_event.remove(Session, "after_commit", revoke_once)
    assert fired
    assert response.status_code == 201, response.text
    assert response.json()["user_id"] == staff_user.id
    assert client.get(f"/events/{event['id']}/staff", headers=owner).json() == []
