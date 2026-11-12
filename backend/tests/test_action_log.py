"""The event timeline (SRS 4.16): every management action is recorded once, by its actor, and can be filtered."""
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from app.models import ActionLog

REASON = {"reason": "Reported as fraudulent"}


def new_request_id():
    return str(uuid.uuid4())


def timeline(client, event_id, headers, **params):
    """The event's actions, oldest first."""
    response = client.get(f"/events/{event_id}/action-log", params=params, headers=headers)
    assert response.status_code == 200, response.text
    return list(reversed(response.json()))


def actions(client, event_id, headers, **params):
    return [entry["action"] for entry in timeline(client, event_id, headers, **params)]


def row_count(db):
    db.expire_all()
    return db.scalar(select(func.count()).select_from(ActionLog))


@pytest.fixture()
def actors(login_as):
    admin_user, admin = login_as("admin@example.com", "admin")
    owner_user, owner = login_as("owner@example.com", "organizer")
    staff_user, staff = login_as("staff@example.com")
    visitor_user, visitor = login_as("visitor@example.com")
    return SimpleNamespace(
        admin=admin, admin_user=admin_user, owner=owner, owner_user=owner_user,
        staff=staff, staff_user=staff_user, visitor=visitor, visitor_user=visitor_user,
    )


def scan(client, event_id, qr_payload, headers, request_id=None):
    body = {"qr_payload": qr_payload, "request_id": request_id or new_request_id()}
    return client.post(f"/events/{event_id}/check-in", json=body, headers=headers)


# ------------------------------------------------------------------ what is recorded
def test_whole_event_lifecycle_is_recorded_once_per_real_change(client, actors, new_event, login_as):
    event = new_event(actors.owner, publish=False, capacity=10)
    event_id = event["id"]
    root = f"/events/{event_id}"
    expected = ["event.created", "ticket_type.created"]
    assert actions(client, event_id, actors.owner) == expected

    def step(new_actions, response, status=200):
        assert response.status_code == status, response.text
        expected.extend(new_actions)
        assert actions(client, event_id, actors.owner) == expected
        return response

    # Publishing, and publishing again.
    step(["event.published"], client.post(f"{root}/publish", headers=actors.owner))
    step([], client.post(f"{root}/publish", headers=actors.owner))

    # Edits: the default type follows the capacity; an edit that changes nothing is not an action.
    step(["ticket_type.updated", "event.updated"],
         client.patch(root, json={"capacity": 20, "title": "Renamed event"}, headers=actors.owner))
    step([], client.patch(root, json={"capacity": 20, "title": "Renamed event"}, headers=actors.owner))

    # Staff.
    step(["staff.assigned"], client.post(f"{root}/staff", json={"email": "staff@example.com"}, headers=actors.owner), 201)
    step([], client.post(f"{root}/staff", json={"email": "staff@example.com"}, headers=actors.owner))

    # Claiming tickets is not a management action.
    ticket = step([], client.post(f"{root}/tickets", headers=actors.visitor), 201).json()
    _, second_headers = login_as("second@example.com")
    second = step([], client.post(f"{root}/tickets", headers=second_headers), 201).json()

    # Check-in: one entry per admission; a replayed retry and a rejected duplicate add none.
    request_id = new_request_id()
    receipt = step(["check_in.created"], scan(client, event_id, ticket["qr_payload"], actors.staff, request_id)).json()
    step([], scan(client, event_id, ticket["qr_payload"], actors.staff, request_id))
    step([], scan(client, event_id, ticket["qr_payload"], actors.staff), 409)

    # Undo: once; the retried undo adds none.
    undo_path = f"{root}/check-ins/{receipt['check_in_id']}/undo"
    undo_request = {"request_id": new_request_id()}
    step(["check_in.undone"], client.post(undo_path, json=undo_request, headers=actors.owner))
    step([], client.post(undo_path, json=undo_request, headers=actors.owner))

    # Closing tickets: by the attendee and by the organizer; repeating is a no-op.
    step(["ticket.cancelled"], client.post(f"/tickets/{ticket['id']}/cancel", headers=actors.visitor))
    step([], client.post(f"/tickets/{ticket['id']}/cancel", headers=actors.visitor))
    step(["ticket.refunded"], client.post(f"/tickets/{second['id']}/refund", headers=actors.owner))

    step(["staff.removed"], client.delete(f"{root}/staff/{actors.staff_user.id}", headers=actors.owner), 204)
    step([], client.delete(f"{root}/staff/{actors.staff_user.id}", headers=actors.owner), 204)

    # Admin suspension, then the final cancellation.
    step(["event.suspended"], client.post(f"/admin{root}/suspend", json=REASON, headers=actors.admin))
    step(["event.reactivated"], client.post(f"/admin{root}/reactivate", headers=actors.admin))
    step(["event.cancelled"], client.post(f"{root}/cancel", headers=actors.owner))
    step([], client.post(f"{root}/cancel", headers=actors.owner))


def test_entries_name_the_actor_the_entity_and_what_changed(client, actors, new_event):
    event = new_event(actors.owner, capacity=10)
    event_id = event["id"]
    root = f"/events/{event_id}"
    client.patch(root, json={"capacity": 25, "location": "Main hall", "date": "2031-05-01T10:00:00Z"},
                 headers=actors.owner)
    client.post(f"{root}/staff", json={"email": "staff@example.com"}, headers=actors.owner)
    ticket = client.post(f"{root}/tickets", headers=actors.visitor).json()
    receipt = scan(client, event_id, ticket["qr_payload"], actors.staff).json()
    client.post(f"{root}/check-ins/{receipt['check_in_id']}/undo", json={"request_id": new_request_id()},
                headers=actors.owner)
    client.post(f"/tickets/{ticket['id']}/cancel", headers=actors.visitor)

    entries = {entry["action"]: entry for entry in timeline(client, event_id, actors.owner)}
    assert set(entries["event.updated"]) == {
        "id", "event_id", "occurred_at", "actor_id", "actor_name", "action", "entity_type", "entity_id", "description",
    }

    def facts(action):
        entry = entries[action]
        assert entry["event_id"] == event_id
        return entry["actor_id"], entry["actor_name"], entry["entity_type"], entry["entity_id"]

    owner, staff, visitor = actors.owner_user, actors.staff_user, actors.visitor_user
    assert facts("event.created") == (owner.id, owner.full_name, "event", event_id)
    assert facts("event.published") == (owner.id, owner.full_name, "event", event_id)
    assert facts("event.updated") == (owner.id, owner.full_name, "event", event_id)
    assert facts("staff.assigned") == (owner.id, owner.full_name, "user", staff.id)
    assert facts("check_in.created") == (staff.id, staff.full_name, "check_in", receipt["check_in_id"])
    assert facts("check_in.undone") == (owner.id, owner.full_name, "check_in", receipt["check_in_id"])
    assert facts("ticket.cancelled") == (visitor.id, visitor.full_name, "ticket", ticket["id"])

    changed = entries["event.updated"]["description"]
    assert "capacity: 10 -> 25" in changed
    assert "date: " in changed and "2031-05-01T10:00:00+00:00" in changed
    assert "location: changed" in changed and "Main hall" not in changed
    assert "staff@example.com" in entries["staff.assigned"]["description"]
    assert str(ticket["id"]) in entries["check_in.created"]["description"]
    assert "attendee" in entries["ticket.cancelled"]["description"]


def test_refused_changes_leave_no_history(client, db, actors, new_event):
    event = new_event(actors.owner, capacity=2)
    root = f"/events/{event['id']}"
    ticket = client.post(f"{root}/tickets", headers=actors.visitor).json()
    assert scan(client, event["id"], ticket["qr_payload"], actors.owner).status_code == 200
    before = row_count(db)

    refused = [
        client.patch(root, json={"capacity": 0}, headers=actors.owner),                      # 422
        client.patch(root, json={"title": "Hijacked"}, headers=actors.visitor),               # 403
        client.post(f"{root}/cancel", headers=actors.visitor),                                # 403
        client.post(f"{root}/staff", json={"email": "nobody@example.com"}, headers=actors.owner),  # 404
        client.post(f"/tickets/{ticket['id']}/cancel", headers=actors.visitor),               # 409: checked in
        client.post(f"/tickets/{ticket['id']}/refund", headers=actors.visitor),               # 403
        scan(client, event["id"], "biletflow:ticket:v1:unknown", actors.owner),               # 404
        client.post(f"{root}/check-ins/999999/undo", json={"request_id": new_request_id()}, headers=actors.owner),
        client.post(f"/admin{root}/suspend", json=REASON, headers=actors.owner),              # 403
    ]
    assert [response.status_code for response in refused] == [422, 403, 403, 404, 409, 403, 404, 404, 403]
    assert row_count(db) == before


def test_capacity_below_issued_is_refused_without_history(client, db, actors, new_event, login_as):
    event = new_event(actors.owner, capacity=5)
    root = f"/events/{event['id']}"
    client.post(f"{root}/tickets", headers=actors.visitor)
    client.post(f"{root}/tickets", headers=actors.staff)
    before = row_count(db)
    response = client.patch(root, json={"capacity": 1}, headers=actors.owner)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "CAPACITY_BELOW_ISSUED"
    assert row_count(db) == before


# ------------------------------------------------------------------ reading
@pytest.mark.parametrize("who", ["guest", "visitor", "staff", "other_organizer"])
def test_only_the_organizer_and_admins_read_the_timeline(client, actors, new_event, login_as, who):
    event = new_event(actors.owner)
    client.post(f"/events/{event['id']}/staff", json={"email": "staff@example.com"}, headers=actors.owner)
    headers = {
        "guest": None,
        "visitor": actors.visitor,
        "staff": actors.staff,
        "other_organizer": login_as("other-owner@example.com", "organizer")[1],
    }[who]
    response = client.get(f"/events/{event['id']}/action-log", headers=headers)
    assert response.status_code == (401 if who == "guest" else 403)
    for allowed in (actors.owner, actors.admin):
        assert client.get(f"/events/{event['id']}/action-log", headers=allowed).status_code == 200


def test_timeline_of_a_missing_event_is_event_not_found(client, actors):
    response = client.get("/events/999999/action-log", headers=actors.admin)
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "EVENT_NOT_FOUND"


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_history_cannot_be_written_or_deleted_through_the_api(client, actors, new_event, method):
    event = new_event(actors.owner)
    for path in (f"/events/{event['id']}/action-log", "/admin/action-log"):
        assert client.request(method.upper(), path, json={}, headers=actors.admin).status_code == 405


@pytest.fixture()
def busy_event(client, actors, new_event):
    """A published event with a staff assignment, a check-in and its undo."""
    event = new_event(actors.owner)
    root = f"/events/{event['id']}"
    client.post(f"{root}/staff", json={"email": "staff@example.com"}, headers=actors.owner)
    ticket = client.post(f"{root}/tickets", headers=actors.visitor).json()
    receipt = scan(client, event["id"], ticket["qr_payload"], actors.staff).json()
    client.post(f"{root}/check-ins/{receipt['check_in_id']}/undo", json={"request_id": new_request_id()},
                headers=actors.owner)
    return event


def test_filter_by_action_type_or_prefix(client, actors, busy_event):
    event_id = busy_event["id"]
    everything = ["event.created", "ticket_type.created", "event.published", "staff.assigned",
                  "check_in.created", "check_in.undone"]
    assert actions(client, event_id, actors.owner) == everything
    assert actions(client, event_id, actors.owner, action="check_in") == ["check_in.created", "check_in.undone"]
    assert actions(client, event_id, actors.owner, action="check_in.undone") == ["check_in.undone"]
    assert actions(client, event_id, actors.owner, action="event") == ["event.created", "event.published"]
    assert actions(client, event_id, actors.owner, action="  staff  ") == ["staff.assigned"]
    assert actions(client, event_id, actors.owner, action="") == everything
    # "_" and "%" are literal, and nothing matches NUL.
    for nothing in ("check.in", "%", "check_in%", "refund", "check_in\x00"):
        assert actions(client, event_id, actors.owner, action=nothing) == [], nothing
    too_long = client.get(f"/events/{event_id}/action-log", params={"action": "x" * 81}, headers=actors.owner)
    assert too_long.status_code == 422


@pytest.fixture()
def mixed_event(client, actors, new_event):
    """One event whose history holds ticket.cancelled, ticket_type.created and check_in.created."""
    event = new_event(actors.owner)
    root = f"/events/{event['id']}"
    ticket = client.post(f"{root}/tickets", headers=actors.visitor).json()
    assert scan(client, event["id"], ticket["qr_payload"], actors.owner).status_code == 200
    returned = client.post(f"{root}/tickets", headers=actors.staff).json()
    assert client.post(f"/tickets/{returned['id']}/cancel", headers=actors.staff).status_code == 200
    assert actions(client, event["id"], actors.owner) == [
        "event.created", "ticket_type.created", "event.published", "check_in.created", "ticket.cancelled",
    ]
    return event


# A group is the text before a dot, never a raw prefix: "ticket" is not "ticket_type" and "check" is not "check_in".
ACTION_GROUPS = [
    ("ticket", ["ticket.cancelled"]),
    ("ticket_type", ["ticket_type.created"]),
    ("ticket.cancelled", ["ticket.cancelled"]),
    ("check", []),
    ("check_in", ["check_in.created"]),
    # A trailing dot behaves like no dot.
    ("ticket.", ["ticket.cancelled"]),
    ("ticket_type.", ["ticket_type.created"]),
    ("check.", []),
    # Neither a longer name, a part of a name, nor a lone dot is a group.
    ("ticket_typ", []),
    ("ticket.cancel", []),
    ("ticket.cancelled.", ["ticket.cancelled"]),
    ("ticket..", []),
    ("ticket_", []),
    ("ticket%", []),
    (".", []),
]


@pytest.mark.parametrize(("action", "expected"), ACTION_GROUPS)
def test_action_filter_matches_a_whole_action_or_group_on_the_event_timeline(
    client, actors, mixed_event, action, expected
):
    assert actions(client, mixed_event["id"], actors.owner, action=action) == expected


@pytest.mark.parametrize(("action", "expected"), ACTION_GROUPS)
def test_action_filter_matches_a_whole_action_or_group_on_the_platform_history(
    client, actors, mixed_event, action, expected
):
    # The only event in this database, so the platform history holds exactly its rows.
    response = client.get("/admin/action-log", params={"action": action}, headers=actors.admin)
    assert response.status_code == 200, response.text
    assert [entry["action"] for entry in response.json()] == expected
    scoped = client.get("/admin/action-log", params={"action": action, "event_id": mixed_event["id"]},
                        headers=actors.admin)
    assert [entry["action"] for entry in scoped.json()] == expected


def test_filter_by_date_range(client, actors, busy_event):
    event_id = busy_event["id"]
    now = datetime.now(timezone.utc)
    past, future = (now - timedelta(hours=1)).isoformat(), (now + timedelta(hours=1)).isoformat()
    assert len(actions(client, event_id, actors.owner, date_from=past, date_to=future)) == 6
    assert len(actions(client, event_id, actors.owner, date_from=past)) == 6
    assert actions(client, event_id, actors.owner, date_from=future) == []
    assert actions(client, event_id, actors.owner, date_to=past) == []
    # A value without a timezone is UTC, as everywhere else in the API.
    naive_past = (now - timedelta(hours=1)).replace(tzinfo=None).isoformat()
    assert len(actions(client, event_id, actors.owner, date_from=naive_past)) == 6
    # Other offsets are converted: one hour ago written in UTC+5.
    astana = (now - timedelta(hours=1)).astimezone(timezone(timedelta(hours=5))).isoformat()
    assert len(actions(client, event_id, actors.owner, date_from=astana)) == 6
    invalid = client.get(f"/events/{event_id}/action-log", params={"date_from": "yesterday"}, headers=actors.owner)
    assert invalid.status_code == 422


def test_paging_returns_the_newest_entries_first(client, actors, busy_event):
    event_id = busy_event["id"]
    path = f"/events/{event_id}/action-log"
    newest_two = client.get(path, params={"limit": 2}, headers=actors.owner).json()
    assert [entry["action"] for entry in newest_two] == ["check_in.undone", "check_in.created"]
    next_two = client.get(path, params={"limit": 2, "offset": 2}, headers=actors.owner).json()
    assert [entry["action"] for entry in next_two] == ["staff.assigned", "event.published"]
    assert client.get(path, params={"offset": 6}, headers=actors.owner).json() == []
    for bad in ({"limit": 0}, {"limit": 501}, {"offset": -1}):
        assert client.get(path, params=bad, headers=actors.owner).status_code == 422


def test_default_page_holds_at_most_200_entries(client, db, actors, new_event):
    event = new_event(actors.owner)
    db.add_all(
        ActionLog(event_id=event["id"], actor_id=actors.owner_user.id, action="check_in.created",
                  entity_type="check_in", entity_id=number, description="bulk")
        for number in range(1, 251)
    )
    db.commit()
    path = f"/events/{event['id']}/action-log"
    assert len(client.get(path, headers=actors.owner).json()) == 200
    assert len(client.get(path, params={"limit": 500}, headers=actors.owner).json()) == 253


# ------------------------------------------------------------------ platform history
def test_platform_history_holds_every_event_and_user_actions(client, actors, new_event):
    first = new_event(actors.owner)
    second = new_event(actors.owner, publish=False)
    client.post(f"/admin/users/{actors.visitor_user.id}/suspend", json=REASON, headers=actors.admin)

    everything = client.get("/admin/action-log", headers=actors.admin).json()
    assert everything[0]["action"] == "user.suspended"
    assert (everything[0]["event_id"], everything[0]["entity_type"], everything[0]["entity_id"]) == (
        None, "user", actors.visitor_user.id,
    )
    assert everything[0]["actor_name"] == actors.admin_user.full_name
    assert {entry["event_id"] for entry in everything} == {None, first["id"], second["id"]}

    only_second = client.get("/admin/action-log", params={"event_id": second["id"]}, headers=actors.admin).json()
    assert [entry["action"] for entry in reversed(only_second)] == ["event.created", "ticket_type.created"]
    users = client.get("/admin/action-log", params={"action": "user"}, headers=actors.admin).json()
    assert [entry["action"] for entry in users] == ["user.suspended"]

    # An organizer's timeline never shows platform actions or other events.
    own = timeline(client, first["id"], actors.owner)
    assert {entry["event_id"] for entry in own} == {first["id"]}
    assert all(not entry["action"].startswith("user.") for entry in own)
