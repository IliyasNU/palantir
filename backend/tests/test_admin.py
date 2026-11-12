"""/admin: platform admins find and suspend users and events (SRS 4.12)."""
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import ActionLog, Event, User
from app.routers import tickets as tickets_router
from tests.helpers import DEFAULT_PASSWORD

REASON = {"reason": "Reported as fraudulent"}

ADMIN_ROUTES = [
    ("get", "/admin/users", None),
    ("post", "/admin/users/2/suspend", REASON),  # user 1 is the admin, who cannot suspend themselves
    ("post", "/admin/users/2/reactivate", None),
    ("get", "/admin/events", None),
    ("post", "/admin/events/1/suspend", REASON),
    ("post", "/admin/events/1/reactivate", None),
    ("get", "/admin/action-log", None),
]


def detail_code(response):
    return response.json()["detail"]["code"]


def call(client, method, path, body=None, headers=None):
    return client.request(method.upper(), path, json=body, headers=headers)


def log_rows(db, **filters):
    db.expire_all()
    query = select(ActionLog).order_by(ActionLog.id)
    for column, value in filters.items():
        query = query.where(getattr(ActionLog, column) == value)
    return db.scalars(query).all()


@pytest.fixture()
def actors(login_as):
    admin_user, admin = login_as("admin@example.com", "admin")
    owner_user, owner = login_as("owner@example.com", "organizer")
    visitor_user, visitor = login_as("visitor@example.com")
    return SimpleNamespace(
        admin=admin, admin_user=admin_user, owner=owner, owner_user=owner_user,
        visitor=visitor, visitor_user=visitor_user,
    )


# ------------------------------------------------------------------ access
@pytest.mark.parametrize(("method", "path", "body"), ADMIN_ROUTES)
def test_admin_routes_need_a_signed_in_admin(client, actors, new_event, method, path, body):
    new_event(actors.owner)
    assert call(client, method, path, body).status_code == 401
    assert call(client, method, path, body, actors.owner).status_code == 403
    assert call(client, method, path, body, actors.visitor).status_code == 403
    assert call(client, method, path, body, actors.admin).status_code == 200


# ------------------------------------------------------------------ users
def test_search_users_by_name_or_email_case_insensitively(client, actors, create_user):
    create_user("aigerim@example.com", full_name="Aigerim Sadykova")
    for q in ("AIGERIM", "sadyk", "aigerim@EXAMPLE", "  Sadykova  "):
        found = client.get("/admin/users", params={"q": q}, headers=actors.admin).json()
        assert [user["email"] for user in found] == ["aigerim@example.com"], q
    [user] = client.get("/admin/users", params={"q": "aigerim"}, headers=actors.admin).json()
    assert set(user) == {"id", "email", "full_name", "role", "is_active", "created_at"}
    assert (user["role"], user["is_active"]) == ("attendee", True)


def test_search_users_without_a_query_lists_the_newest_first_and_respects_the_limit(client, actors, create_user):
    create_user("newest@example.com")
    everyone = client.get("/admin/users", headers=actors.admin).json()
    assert [user["email"] for user in everyone][:2] == ["newest@example.com", "visitor@example.com"]
    assert len(client.get("/admin/users", params={"limit": 2}, headers=actors.admin).json()) == 2
    assert client.get("/admin/users", params={"limit": 51}, headers=actors.admin).status_code == 422
    assert client.get("/admin/users", params={"limit": 0}, headers=actors.admin).status_code == 422


@pytest.mark.parametrize("q", ["%", "_____", "own_r", "nobody-here", "owner\x00"])
def test_search_users_treats_wildcards_literally(client, actors, q):
    response = client.get("/admin/users", params={"q": q}, headers=actors.admin)
    assert response.status_code == 200
    assert response.json() == []


def test_suspended_user_cannot_sign_in_or_use_an_existing_token(client, db, actors):
    target = actors.visitor_user.id
    assert client.get("/auth/me", headers=actors.visitor).status_code == 200

    suspended = client.post(f"/admin/users/{target}/suspend", json=REASON, headers=actors.admin)
    assert suspended.status_code == 200, suspended.text
    assert suspended.json()["is_active"] is False

    assert client.get("/auth/me", headers=actors.visitor).status_code == 403
    assert client.get("/tickets/me", headers=actors.visitor).status_code == 403
    login = client.post("/auth/login", json={"email": "visitor@example.com", "password": DEFAULT_PASSWORD})
    assert login.status_code == 403

    [entry] = log_rows(db, action="user.suspended")
    assert (entry.event_id, entry.actor_id, entry.entity_type, entry.entity_id) == (
        None, actors.admin_user.id, "user", target,
    )
    assert REASON["reason"] in entry.description


def test_user_suspension_and_reactivation_are_idempotent_and_reversible(client, db, actors):
    target = actors.visitor_user.id
    for _ in range(2):
        assert client.post(f"/admin/users/{target}/suspend", json=REASON, headers=actors.admin).status_code == 200
    assert len(log_rows(db, action="user.suspended")) == 1

    for _ in range(2):
        restored = client.post(f"/admin/users/{target}/reactivate", headers=actors.admin)
        assert restored.status_code == 200 and restored.json()["is_active"] is True
    assert len(log_rows(db, action="user.reactivated")) == 1

    assert client.get("/auth/me", headers=actors.visitor).status_code == 200
    login = client.post("/auth/login", json={"email": "visitor@example.com", "password": DEFAULT_PASSWORD})
    assert login.status_code == 200


def test_reactivating_an_active_user_writes_no_history(client, db, actors):
    response = client.post(f"/admin/users/{actors.visitor_user.id}/reactivate", headers=actors.admin)
    assert response.status_code == 200 and response.json()["is_active"] is True
    assert log_rows(db, entity_type="user") == []


def test_admin_cannot_suspend_their_own_account(client, db, actors):
    response = client.post(f"/admin/users/{actors.admin_user.id}/suspend", json=REASON, headers=actors.admin)
    assert response.status_code == 409
    assert detail_code(response) == "CANNOT_SUSPEND_SELF"
    assert client.get("/auth/me", headers=actors.admin).status_code == 200
    assert log_rows(db, entity_type="user") == []


def test_admin_can_suspend_another_admin(client, actors, login_as):
    other, other_headers = login_as("second-admin@example.com", "admin")
    assert client.post(f"/admin/users/{other.id}/suspend", json=REASON, headers=actors.admin).status_code == 200
    assert client.get("/admin/users", headers=other_headers).status_code == 403


@pytest.mark.parametrize("action", ["suspend", "reactivate"])
def test_unknown_user_is_user_not_found(client, actors, action):
    response = client.post(f"/admin/users/999999/{action}", json=REASON, headers=actors.admin)
    assert response.status_code == 404
    assert detail_code(response) == "USER_NOT_FOUND"


@pytest.mark.parametrize(
    "body", [None, {}, {"reason": ""}, {"reason": "  a "}, {"reason": "x" * 301}, {"reason": "valid", "extra": 1}]
)
@pytest.mark.parametrize("target", ["users", "events"])
def test_suspension_needs_a_reason_of_3_to_300_characters(client, db, actors, new_event, target, body):
    event = new_event(actors.owner)
    ident = actors.visitor_user.id if target == "users" else event["id"]
    response = client.post(f"/admin/{target}/{ident}/suspend", json=body, headers=actors.admin)
    assert response.status_code == 422
    db.expire_all()
    assert db.get(User, actors.visitor_user.id).is_active is True
    assert db.get(Event, event["id"]).suspended_at is None


# ------------------------------------------------------------------ events
def test_suspended_event_is_hidden_from_the_public_and_stops_claims(client, actors, new_event, login_as):
    event = new_event(actors.owner)
    root = f"/events/{event['id']}"
    assert event["suspended"] is False

    suspended = client.post(f"/admin{root}/suspend", json=REASON, headers=actors.admin)
    assert suspended.status_code == 200, suspended.text
    body = suspended.json()
    assert body["suspended"] is True and body["suspended_at"] is not None
    assert body["status"] == "published"  # suspension does not change the lifecycle status

    assert client.get("/events").json() == []
    for headers in (None, actors.visitor):
        for path in (root, f"{root}/ticket-types"):
            hidden = client.get(path, headers=headers)
            assert hidden.status_code == 404 and detail_code(hidden) == "EVENT_NOT_FOUND"
    claim = client.post(f"{root}/tickets", headers=actors.visitor)
    assert claim.status_code == 404 and detail_code(claim) == "EVENT_NOT_FOUND"

    # Its organizer and admins still see it, flagged, and cannot issue tickets either.
    for headers in (actors.owner, actors.admin):
        seen = client.get(root, headers=headers)
        assert seen.status_code == 200 and seen.json()["suspended"] is True
    assert [row["suspended"] for row in client.get("/events/mine", headers=actors.owner).json()] == [True]
    own_claim = client.post(f"{root}/tickets", headers=actors.owner)
    assert own_claim.status_code == 409 and detail_code(own_claim) == "EVENT_SUSPENDED"
    assert client.get(root, headers=actors.owner).json()["tickets_issued"] == 0


def test_tickets_issued_before_a_suspension_stay_readable_and_still_admit(client, actors, new_event):
    event = new_event(actors.owner)
    root = f"/events/{event['id']}"
    ticket = client.post(f"{root}/tickets", headers=actors.visitor).json()
    assert client.post(f"/admin{root}/suspend", json=REASON, headers=actors.admin).status_code == 200

    assert client.get(f"/tickets/{ticket['id']}", headers=actors.visitor).status_code == 200
    assert [row["id"] for row in client.get("/tickets/me", headers=actors.visitor).json()] == [ticket["id"]]
    scan = client.post(
        f"{root}/check-in", json={"qr_payload": ticket["qr_payload"], "request_id": str(uuid.uuid4())},
        headers=actors.owner,
    )
    assert scan.status_code == 200, scan.text
    assert client.get(f"{root}/attendance", headers=actors.owner).json()["checked_in"] == 1


def test_reactivation_restores_the_event_exactly(client, actors, new_event):
    event = new_event(actors.owner)
    root = f"/events/{event['id']}"
    client.post(f"/admin{root}/suspend", json=REASON, headers=actors.admin)

    restored = client.post(f"/admin{root}/reactivate", headers=actors.admin)
    assert restored.status_code == 200
    assert (restored.json()["suspended"], restored.json()["suspended_at"], restored.json()["status"]) == (
        False, None, "published",
    )
    assert [row["id"] for row in client.get("/events").json()] == [event["id"]]
    assert client.get(root).status_code == 200
    assert client.post(f"{root}/tickets", headers=actors.visitor).status_code == 201


def test_event_suspension_and_reactivation_are_idempotent(client, db, actors, new_event):
    event = new_event(actors.owner)
    root = f"/admin/events/{event['id']}"
    first = client.post(f"{root}/suspend", json=REASON, headers=actors.admin).json()
    second = client.post(f"{root}/suspend", json={"reason": "Another reason"}, headers=actors.admin).json()
    assert second["suspended_at"] == first["suspended_at"]
    [entry] = log_rows(db, action="event.suspended")
    assert (entry.event_id, entry.actor_id, entry.entity_id) == (event["id"], actors.admin_user.id, event["id"])
    assert REASON["reason"] in entry.description

    for _ in range(2):
        assert client.post(f"{root}/reactivate", headers=actors.admin).status_code == 200
    assert len(log_rows(db, action="event.reactivated")) == 1


def test_reactivating_an_event_that_is_not_suspended_writes_no_history(client, db, actors, new_event):
    event = new_event(actors.owner)
    assert client.post(f"/admin/events/{event['id']}/reactivate", headers=actors.admin).status_code == 200
    assert log_rows(db, action="event.reactivated") == []


def test_suspending_a_draft_keeps_it_a_draft(client, actors, new_event):
    event = new_event(actors.owner, publish=False)
    root = f"/events/{event['id']}"
    assert client.post(f"/admin{root}/suspend", json=REASON, headers=actors.admin).json()["status"] == "draft"
    # Publishing while suspended changes the status only; the event stays hidden until it is reactivated.
    assert client.post(f"{root}/publish", headers=actors.owner).json()["suspended"] is True
    assert client.get("/events").json() == []
    client.post(f"/admin{root}/reactivate", headers=actors.admin)
    assert [row["id"] for row in client.get("/events").json()] == [event["id"]]


@pytest.mark.parametrize("action", ["suspend", "reactivate"])
def test_unknown_event_is_event_not_found(client, actors, action):
    response = client.post(f"/admin/events/999999/{action}", json=REASON, headers=actors.admin)
    assert response.status_code == 404
    assert detail_code(response) == "EVENT_NOT_FOUND"


def test_organizer_reads_who_suspended_the_event_and_why(client, actors, new_event):
    event = new_event(actors.owner)
    client.post(f"/admin/events/{event['id']}/suspend", json=REASON, headers=actors.admin)
    entry = client.get(f"/events/{event['id']}/action-log", headers=actors.owner).json()[0]
    assert entry["action"] == "event.suspended"
    assert (entry["actor_id"], entry["actor_name"]) == (actors.admin_user.id, actors.admin_user.full_name)
    assert REASON["reason"] in entry["description"]


def test_search_events_covers_every_status_and_filters_by_suspension(client, actors, new_event):
    draft = new_event(actors.owner, publish=False, title="Spring Hackathon")
    live = new_event(actors.owner, title="Autumn hackathon")
    other = new_event(actors.owner, title="Chess evening")
    client.post(f"/admin/events/{live['id']}/suspend", json=REASON, headers=actors.admin)

    def ids(**params):
        response = client.get("/admin/events", params=params, headers=actors.admin)
        assert response.status_code == 200, response.text
        return [row["id"] for row in response.json()]

    assert ids() == [other["id"], live["id"], draft["id"]]  # newest first
    assert ids(q="HACKATHON") == [live["id"], draft["id"]]
    assert ids(suspended="true") == [live["id"]]
    assert ids(suspended="false") == [other["id"], draft["id"]]
    assert ids(q="hack", suspended="false") == [draft["id"]]
    assert ids(q="%") == [] and ids(q="hack\x00") == []
    assert ids(limit=1) == [other["id"]]
    [row] = client.get("/admin/events", params={"suspended": "true"}, headers=actors.admin).json()
    assert row["suspended"] is True and row["suspended_at"] is not None


def test_claim_that_races_a_suspension_is_refused_and_takes_no_seat(client, db, actors, new_event, monkeypatch):
    """The suspension commits after the claim's first status check and before its seat UPDATE."""
    event = new_event(actors.owner)
    root = f"/events/{event['id']}"
    real_check = tickets_router._ensure_open_for_tickets
    calls = []

    def check_then_suspend(checked_event):
        real_check(checked_event)
        calls.append(1)
        if len(calls) == 1:
            suspended = client.post(f"/admin{root}/suspend", json=REASON, headers=actors.admin)
            assert suspended.status_code == 200, suspended.text

    monkeypatch.setattr(tickets_router, "_ensure_open_for_tickets", check_then_suspend)
    response = client.post(f"{root}/tickets", headers=actors.visitor)
    assert response.status_code == 409
    assert detail_code(response) == "EVENT_SUSPENDED"

    db.expire_all()
    assert db.get(Event, event["id"]).tickets_issued == 0
    assert client.get("/tickets/me", headers=actors.visitor).json() == []
