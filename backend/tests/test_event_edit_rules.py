"""BE-1: when an event may be edited, and taking a published event back to draft (SRS 4.2)."""
from datetime import timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.db.base import utcnow
from app.models import ActionLog, Event
from app.models.order import Order
from app.routers import tickets as tickets_router
from tests.helpers import future_iso


def detail_code(response):
    return response.json()["detail"]["code"]


@pytest.fixture()
def people(login_as):
    owner_user, owner = login_as("owner@example.com", "organizer")
    admin_user, admin = login_as("admin@example.com", "admin")
    other_user, other_owner = login_as("other@example.com", "organizer")
    staff_user, staff = login_as("staff@example.com")
    visitor_user, visitor = login_as("visitor@example.com")
    return SimpleNamespace(owner=owner, owner_user=owner_user, admin=admin, other_owner=other_owner,
                           staff=staff, staff_user=staff_user, visitor=visitor, visitor_user=visitor_user)


def start_now(db, event_id, hours_ago=1):
    """Move an event's start into the past, as if time had passed."""
    event = db.get(Event, event_id)
    event.date = utcnow() - timedelta(hours=hours_ago)
    db.commit()
    return event.date


def history(db, event_id, action):
    db.expire_all()
    return db.scalars(select(ActionLog).where(ActionLog.event_id == event_id, ActionLog.action == action)).all()


# ------------------------------------------------------------------ cancelled events are final
@pytest.mark.parametrize("who", ["owner", "admin"])
@pytest.mark.parametrize("body", [{"title": "New title"}, {"description": None}, {"capacity": 300},
                                  {"date": future_iso(60)}, {"location": "Elsewhere"}])
def test_cancelled_event_cannot_be_edited(client, db, people, new_event, who, body):
    event = new_event(people.owner)
    client.post(f"/events/{event['id']}/cancel", headers=people.owner)
    before = client.get(f"/events/{event['id']}").json()
    for method in ("PATCH", "PUT"):
        response = client.request(method, f"/events/{event['id']}", json=body, headers=getattr(people, who))
        assert (response.status_code, detail_code(response)) == (409, "EVENT_CANCELLED")
        assert response.json()["detail"]["message"] == "A cancelled event cannot be edited"
    after = client.get(f"/events/{event['id']}").json()
    assert {key: after[key] for key in ("title", "description", "capacity", "date", "location")} == {
        key: before[key] for key in ("title", "description", "capacity", "date", "location")
    }
    assert history(db, event["id"], "event.updated") == []


def test_cancelled_draft_cannot_be_edited_either(client, people, new_event):
    draft = new_event(people.owner, publish=False)
    client.post(f"/events/{draft['id']}/cancel", headers=people.owner)
    response = client.patch(f"/events/{draft['id']}", json={"title": "Renamed draft"}, headers=people.owner)
    assert (response.status_code, detail_code(response)) == (409, "EVENT_CANCELLED")


def test_ticket_types_of_a_cancelled_event_are_frozen(client, db, people, new_event):
    event = new_event(people.owner, capacity=10)
    default = event["ticket_types"][0]
    client.post(f"/events/{event['id']}/cancel", headers=people.owner)
    path = f"/events/{event['id']}/ticket-types"
    for headers in (people.owner, people.admin):
        created = client.post(path, json={"name": "Late type", "quantity": 1}, headers=headers)
        edited = client.patch(f"{path}/{default['id']}", json={"quantity": 5}, headers=headers)
        assert (created.status_code, detail_code(created)) == (409, "EVENT_CANCELLED")
        assert (edited.status_code, detail_code(edited)) == (409, "EVENT_CANCELLED")
    assert [row["quantity"] for row in client.get(f"{path}/manage", headers=people.owner).json()] == [10]


def test_access_is_checked_before_the_editing_rules(client, people, new_event):
    """Someone who may not manage the event learns nothing about its state."""
    event = new_event(people.owner)
    client.post(f"/events/{event['id']}/cancel", headers=people.owner)
    for headers in (people.other_owner, people.visitor):
        response = client.patch(f"/events/{event['id']}", json={"title": "Hijacked"}, headers=headers)
        assert (response.status_code, detail_code(response)) == (403, "FORBIDDEN")
    assert client.patch(f"/events/{event['id']}", json={"title": "Hijacked"}).status_code == 401
    missing = client.patch("/events/999999", json={"title": "Whatever"}, headers=people.owner)
    assert (missing.status_code, detail_code(missing)) == (404, "EVENT_NOT_FOUND")


# ------------------------------------------------------------------ started events
@pytest.mark.parametrize("who", ["owner", "admin"])
@pytest.mark.parametrize("body", [{"date": future_iso(10)}, {"capacity": 200}, {"capacity": 151},
                                  {"date": future_iso(10), "title": "Moved"}])
def test_started_event_keeps_its_date_and_capacity(client, db, people, new_event, who, body):
    event = new_event(people.owner, capacity=150)
    start_now(db, event["id"])
    before = client.get(f"/events/{event['id']}").json()
    response = client.patch(f"/events/{event['id']}", json=body, headers=getattr(people, who))
    assert (response.status_code, detail_code(response)) == (409, "EVENT_STARTED")
    after = client.get(f"/events/{event['id']}").json()
    assert (after["date"], after["capacity"], after["title"]) == (before["date"], before["capacity"], before["title"])
    assert history(db, event["id"], "event.updated") == []


def test_started_event_texts_and_location_can_still_be_corrected(client, db, people, new_event):
    event = new_event(people.owner, capacity=150)
    started_at = start_now(db, event["id"])
    current = client.get(f"/events/{event['id']}").json()
    response = client.patch(f"/events/{event['id']}", headers=people.owner, json={
        "title": "Corrected title", "description": "Corrected text", "location": "Hall B",
        # The current date and capacity, sent again, are not changes.
        "date": current["date"], "capacity": 150,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["title"], body["description"], body["location"], body["capacity"]) == (
        "Corrected title", "Corrected text", "Hall B", 150,
    )
    assert body["date"] == current["date"]
    [entry] = history(db, event["id"], "event.updated")
    assert "date" not in entry.description and "capacity" not in entry.description
    assert db.get(Event, event["id"]).date.replace(tzinfo=None) == started_at.replace(tzinfo=None)


def test_event_that_has_not_started_can_still_move(client, people, new_event):
    event = new_event(people.owner)
    response = client.patch(f"/events/{event['id']}", json={"date": future_iso(90), "capacity": 300},
                            headers=people.owner)
    assert response.status_code == 200, response.text
    assert response.json()["capacity"] == 300


# ------------------------------------------------------------------ new dates
@pytest.mark.parametrize("delta", [timedelta(minutes=-1), timedelta(days=-400), timedelta(0)])
def test_new_date_must_be_in_the_future(client, db, people, new_event, delta):
    event = new_event(people.owner)
    for draft_or_published in (event, new_event(people.owner, publish=False)):
        new_date = (utcnow() + delta).isoformat()
        response = client.patch(f"/events/{draft_or_published['id']}", json={"date": new_date}, headers=people.owner)
        assert (response.status_code, detail_code(response)) == (422, "DATE_IN_PAST")
        assert client.get(f"/events/{draft_or_published['id']}", headers=people.owner).json()["date"] == \
            draft_or_published["date"]


def test_naive_and_offset_dates_are_compared_in_utc(client, people, new_event):
    event = new_event(people.owner)
    soon = utcnow() + timedelta(minutes=30)
    # Written in UTC+5: 30 minutes ahead, still in the future.
    astana = soon.astimezone(timezone(timedelta(hours=5))).isoformat()
    assert client.patch(f"/events/{event['id']}", json={"date": astana}, headers=people.owner).status_code == 200
    # A naive value is UTC: one hour ago is in the past even though it might read as "later" locally.
    naive_past = (utcnow() - timedelta(hours=1)).replace(tzinfo=None).isoformat()
    response = client.patch(f"/events/{event['id']}", json={"date": naive_past}, headers=people.owner)
    assert (response.status_code, detail_code(response)) == (422, "DATE_IN_PAST")


# ------------------------------------------------------------------ unpublish
def test_unpublish_takes_a_published_event_without_tickets_back_to_draft(client, db, people, new_event):
    event = new_event(people.owner)
    root = f"/events/{event['id']}"
    assert client.post(f"{root}/staff", json={"email": "staff@example.com"}, headers=people.owner).status_code == 201
    assert [row["id"] for row in client.get("/staff/events", headers=people.staff).json()] == [event["id"]]

    response = client.post(f"{root}/unpublish", headers=people.owner)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "draft"

    assert client.get("/events").json() == []
    hidden = client.get(root, headers=people.visitor)
    assert (hidden.status_code, detail_code(hidden)) == (404, "EVENT_NOT_FOUND")
    assert client.get("/staff/events", headers=people.staff).json() == []
    claim = client.post(f"{root}/tickets", headers=people.visitor)
    assert (claim.status_code, detail_code(claim)) == (404, "EVENT_NOT_FOUND")
    # The organizer still has it, with its ticket types and staff, ready to publish again.
    assert client.get(root, headers=people.owner).json()["status"] == "draft"
    assert [row["user_id"] for row in client.get(f"{root}/staff", headers=people.owner).json()] == [people.staff_user.id]

    [entry] = history(db, event["id"], "event.unpublished")
    assert (entry.actor_id, entry.entity_type, entry.entity_id) == (people.owner_user.id, "event", event["id"])

    assert client.post(f"{root}/publish", headers=people.owner).json()["status"] == "published"
    assert [row["id"] for row in client.get("/events").json()] == [event["id"]]
    assert client.post(f"{root}/tickets", headers=people.visitor).status_code == 201


def test_unpublishing_a_draft_is_a_no_op(client, db, people, new_event):
    draft = new_event(people.owner, publish=False)
    for _ in range(2):
        response = client.post(f"/events/{draft['id']}/unpublish", headers=people.owner)
        assert response.status_code == 200 and response.json()["status"] == "draft"
    assert history(db, draft["id"], "event.unpublished") == []


def test_admin_can_unpublish_any_event(client, db, people, new_event):
    event = new_event(people.owner)
    response = client.post(f"/events/{event['id']}/unpublish", headers=people.admin)
    assert response.status_code == 200 and response.json()["status"] == "draft"
    [entry] = history(db, event["id"], "event.unpublished")
    assert entry.actor_id != people.owner_user.id


def test_event_with_an_active_ticket_cannot_be_unpublished(client, db, people, new_event):
    event = new_event(people.owner)
    root = f"/events/{event['id']}"
    ticket = client.post(f"{root}/tickets", headers=people.visitor).json()
    response = client.post(f"{root}/unpublish", headers=people.owner)
    assert (response.status_code, detail_code(response)) == (409, "EVENT_HAS_TICKETS")
    assert client.get(root).json()["status"] == "published"
    assert history(db, event["id"], "event.unpublished") == []

    # Once the only ticket is cancelled its seat is free again, and the event can go back to draft.
    assert client.post(f"/tickets/{ticket['id']}/cancel", headers=people.visitor).status_code == 200
    assert client.post(f"{root}/unpublish", headers=people.owner).json()["status"] == "draft"


@pytest.mark.parametrize("status", ["cancelled", "refunded"])
def test_closed_tickets_do_not_block_unpublishing(client, people, new_event, status):
    event = new_event(people.owner)
    ticket = client.post(f"/events/{event['id']}/tickets", headers=people.visitor).json()
    action = "cancel" if status == "cancelled" else "refund"
    assert client.post(f"/tickets/{ticket['id']}/{action}", headers=people.owner).json()["status"] == status
    assert client.post(f"/events/{event['id']}/unpublish", headers=people.owner).json()["status"] == "draft"
    # The holder can still read their closed ticket.
    assert client.get(f"/tickets/{ticket['id']}", headers=people.visitor).json()["status"] == status


def test_cancelled_event_cannot_be_unpublished(client, db, people, new_event):
    event = new_event(people.owner)
    client.post(f"/events/{event['id']}/cancel", headers=people.owner)
    response = client.post(f"/events/{event['id']}/unpublish", headers=people.owner)
    assert (response.status_code, detail_code(response)) == (409, "EVENT_CANCELLED")
    assert client.get(f"/events/{event['id']}").json()["status"] == "cancelled"


def test_only_the_organizer_or_an_admin_unpublishes(client, people, new_event):
    event = new_event(people.owner)
    path = f"/events/{event['id']}/unpublish"
    assert client.post(path).status_code == 401
    for headers in (people.other_owner, people.staff, people.visitor):
        response = client.post(path, headers=headers)
        assert (response.status_code, detail_code(response)) == (403, "FORBIDDEN")
    missing = client.post("/events/999999/unpublish", headers=people.admin)
    assert (missing.status_code, detail_code(missing)) == (404, "EVENT_NOT_FOUND")
    assert client.get(f"/events/{event['id']}").json()["status"] == "published"


def test_unpublishing_a_suspended_event_keeps_the_suspension(client, people, new_event):
    event = new_event(people.owner)
    client.post(f"/admin/events/{event['id']}/suspend", json={"reason": "Under review"}, headers=people.admin)
    body = client.post(f"/events/{event['id']}/unpublish", headers=people.owner).json()
    assert (body["status"], body["suspended"]) == ("draft", True)


# ------------------------------------------------------------------ unpublish and checkout holds
@pytest.fixture()
def paid_event(client, people, new_event):
    """A published event with an activated paid type, and a way for the visitor to start checkout."""
    event = new_event(people.owner, capacity=4)
    eid = event["id"]
    free = event["ticket_types"][0]["id"]
    assert client.patch(f"/events/{eid}/ticket-types/{free}", headers=people.owner, json={"quantity": 2}).status_code == 200
    paid = client.post(f"/events/{eid}/ticket-types", headers=people.owner,
                       json={"name": "Paid", "price_tiyn": 10050, "quantity": 2}).json()["id"]
    assert client.post("/organizer-profiles", headers=people.owner, json={"organization_name": "Demo"}).status_code == 201
    for route, body in (("/organizer-profiles/me/confirm-identity", None),
                        ("/organizer-profiles/me/payout-details", {"reference_last4": "D123"}),
                        (f"/events/{eid}/activation/terms", None), (f"/events/{eid}/activation/fee", None)):
        assert client.post(route, headers=people.owner, json=body).status_code == 200

    def checkout():
        response = client.post(f"/events/{eid}/orders", headers=people.visitor, json={
            "ticket_type_id": paid, "attendee_name": "Visitor", "attendee_email": "visitor@example.com",
            "request_id": str(uuid4()),
        })
        assert response.status_code == 201, response.text
        return response.json()

    return SimpleNamespace(id=eid, paid_type=paid, checkout=checkout)


def test_pending_order_blocks_unpublishing_until_it_lapses(client, db, people, paid_event):
    order = paid_event.checkout()
    response = client.post(f"/events/{paid_event.id}/unpublish", headers=people.owner)
    assert (response.status_code, detail_code(response)) == (409, "EVENT_HAS_TICKETS")

    # The hold lapses: unpublishing releases it first and then succeeds.
    db.get(Order, order["id"]).expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    response = client.post(f"/events/{paid_event.id}/unpublish", headers=people.owner)
    assert response.status_code == 200, response.text
    assert (response.json()["status"], response.json()["tickets_issued"]) == ("draft", 0)
    db.expire_all()
    assert db.get(Order, order["id"]).status == "expired"


def test_checkout_on_an_unpublished_event_is_refused(client, people, paid_event):
    assert client.post(f"/events/{paid_event.id}/unpublish", headers=people.owner).status_code == 200
    # The organizer can still see the draft, so the answer is about its status, not a hidden event.
    response = client.post(f"/events/{paid_event.id}/orders", headers=people.owner, json={
        "ticket_type_id": paid_event.paid_type, "attendee_name": "Owner", "attendee_email": "owner@example.com",
        "request_id": str(uuid4()),
    })
    assert (response.status_code, detail_code(response)) == (409, "EVENT_NOT_PUBLISHED")


# ------------------------------------------------------------------ races
def test_claim_that_races_an_unpublish_is_refused_and_takes_no_seat(client, db, people, new_event, monkeypatch):
    """The unpublish commits after the claim's first status check and before its seat UPDATE."""
    event = new_event(people.owner)
    root = f"/events/{event['id']}"
    real_check = tickets_router._ensure_open_for_tickets
    calls = []

    def check_then_unpublish(checked_event):
        real_check(checked_event)
        calls.append(1)
        if len(calls) == 1:
            unpublished = client.post(f"{root}/unpublish", headers=people.owner)
            assert unpublished.status_code == 200, unpublished.text

    monkeypatch.setattr(tickets_router, "_ensure_open_for_tickets", check_then_unpublish)
    response = client.post(f"{root}/tickets", headers=people.visitor)
    assert (response.status_code, detail_code(response)) == (409, "EVENT_NOT_PUBLISHED")

    db.expire_all()
    stored = db.get(Event, event["id"])
    assert (stored.status, stored.tickets_issued) == ("draft", 0)
    assert client.get("/tickets/me", headers=people.visitor).json() == []


def test_a_draft_never_holds_a_seat(client, db, people, new_event):
    """The invariant the PostgreSQL race test checks under real concurrency, here in sequence."""
    for _ in range(3):
        event = new_event(people.owner)
        client.post(f"/events/{event['id']}/tickets", headers=people.visitor)
        client.post(f"/events/{event['id']}/unpublish", headers=people.owner)
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Event).where(
        Event.status == "draft", Event.tickets_issued > 0)) == 0
