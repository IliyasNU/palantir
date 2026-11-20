from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.db.base import utcnow
from app.models import Event, Order
from app.models.event import EventPhase, event_phase
from tests.helpers import future_iso, parse_dt


def test_phases_at_start_end_and_explicit_zoned_end():
    start = datetime(2030, 6, 1, 19, tzinfo=timezone(timedelta(hours=5)))
    utc_start = datetime(2030, 6, 1, 14, tzinfo=timezone.utc)
    assert event_phase(start, "published", now=utc_start - timedelta(microseconds=1)) == EventPhase.UPCOMING
    assert event_phase(start, "published", now=utc_start) == EventPhase.ACTIVE
    assert event_phase(start, "published", now=utc_start + timedelta(hours=23, minutes=59)) == EventPhase.ACTIVE
    assert event_phase(start, "published", now=utc_start + timedelta(days=1)) == EventPhase.COMPLETED
    end = utc_start + timedelta(hours=2)
    assert event_phase(start, "published", ends_at=end, now=end - timedelta(microseconds=1)) == EventPhase.ACTIVE
    assert event_phase(start, "published", ends_at=end, now=end) == EventPhase.COMPLETED
    assert event_phase(start, "cancelled", now=utc_start - timedelta(days=4)) == EventPhase.CANCELLED


@pytest.fixture()
def actors(login_as):
    owner_user, owner = login_as("history-owner@example.com", "organizer")
    buyer_user, buyer = login_as("history-buyer@example.com")
    _, visitor = login_as("history-visitor@example.com")
    _, admin = login_as("history-admin@example.com", "admin")
    return owner_user, owner, buyer_user, buyer, visitor, admin


def test_cabinet_classifies_events_without_changing_publication_status(client, db, new_event, actors):
    _, owner, _, _, _, _ = actors
    upcoming = new_event(owner, publish=False)["id"]
    active = new_event(owner)["id"]
    completed = new_event(owner)["id"]
    cancelled = new_event(owner)["id"]
    db.get(Event, active).date = utcnow() - timedelta(minutes=10)
    db.get(Event, completed).date = utcnow() - timedelta(days=2)
    db.commit()
    assert client.post(f"/events/{cancelled}/cancel", headers=owner).status_code == 200
    rows = client.get("/events/mine", headers=owner).json()
    assert {row["id"]: (row["status"], row["phase"]) for row in rows} == {
        upcoming: ("draft", "upcoming"), active: ("published", "active"),
        completed: ("published", "completed"), cancelled: ("cancelled", "cancelled"),
    }


@pytest.mark.parametrize("cancelled", [False, True])
def test_history_and_duplicate_keep_transactions_on_source(client, db, new_event, actors, cancelled):
    owner_user, owner, buyer_user, buyer, visitor, admin = actors
    source = new_event(owner, capacity=20)
    event_id = source["id"]
    root = f"/events/{event_id}"
    default_type = source["ticket_types"][0]["id"]
    assert client.patch(f"{root}/ticket-types/{default_type}", headers=owner, json={"quantity": 15}).status_code == 200
    type_response = client.post(f"{root}/ticket-types", headers=owner, json={
        "name": "Hidden group", "description": "For group admission", "price_tiyn": 1500,
        "quantity": 5, "order_limit": 2, "hidden": True, "sales_start": future_iso(10), "sales_end": future_iso(20),
    })
    assert type_response.status_code == 201, type_response.text
    paid_type = type_response.json()

    first = client.post(f"{root}/tickets", headers=buyer).json()
    second = client.post(f"{root}/tickets", headers=visitor).json()
    scan = client.post(f"{root}/check-in", headers=owner, json={
        "qr_payload": first["qr_payload"], "request_id": str(uuid4()),
    })
    assert scan.status_code == 200, scan.text
    db.add(Order(
        event_id=event_id, ticket_type_id=paid_type["id"], buyer_id=buyer_user.id,
        request_id=str(uuid4()), attendee_name="Fixture", attendee_email="history-buyer@example.com",
        status="failed", subtotal_tiyn=1500, total_tiyn=1500, processing_fee_tiyn=0, processing_fee_bps=0,
        expires_at=utcnow() + timedelta(minutes=10),
    ))
    if not cancelled:
        db.get(Event, event_id).date = utcnow() - timedelta(days=2)
    db.commit()
    if cancelled:
        assert client.post(f"{root}/cancel", headers=owner).status_code == 200

    history = client.get(f"{root}/history", headers=owner, params={"limit": 1}).json()
    assert history["event"]["phase"] == ("cancelled" if cancelled else "completed")
    assert history["has_more"]
    assert history["tickets"][0]["id"] == second["id"]
    assert set(history["tickets"][0]) == {"id", "ticket_type_id", "status", "created_at"}
    assert history["orders"][0]["status"] == "failed"
    assert set(history["orders"][0]) == {"id", "status", "total_tiyn", "created_at"}
    assert history["check_ins"][0]["ticket_id"] == first["id"]
    assert history["check_ins"][0]["undone_at"] is None
    assert client.get(f"{root}/history", headers=admin, params={"limit": 1, "offset": 1}).json()["tickets"][0]["id"] == first["id"]
    assert client.get(f"{root}/history", headers=buyer).status_code == 403
    assert client.get(f"{root}/history", headers=owner, params={"limit": 101}).status_code == 422
    timeline = client.get(f"{root}/action-log", headers=owner).json()
    assert any(row["action"] == "check_in.created" for row in timeline)

    new_date = future_iso(45)
    assert client.post(f"{root}/duplicate", headers=buyer, json={"date": new_date}).status_code == 403
    response = client.post(f"{root}/duplicate", headers=owner, json={"date": new_date})
    assert response.status_code == 201, response.text
    draft = response.json()
    assert draft["id"] != event_id
    assert (draft["organizer_id"], draft["status"], draft["phase"], draft["tickets_issued"]) == (
        owner_user.id, "draft", "upcoming", 0,
    )
    assert not draft["paid_sales_available"]
    assert parse_dt(draft["date"]) == parse_dt(new_date)
    for field in ("title", "description", "location", "capacity"):
        assert draft[field] == source[field]

    draft_root = f"/events/{draft['id']}"
    assert client.get(draft_root).status_code == 404
    copied_types = client.get(f"{draft_root}/ticket-types/manage", headers=owner).json()
    default_copy, paid_copy = copied_types
    assert default_copy["id"] != default_type and default_copy["is_default"] and default_copy["quantity"] == 15
    assert paid_copy["id"] != paid_type["id"]
    for field in ("name", "description", "quantity", "price_tiyn", "order_limit", "hidden"):
        assert paid_copy[field] == paid_type[field]
    assert all(row["tickets_issued"] == 0 for row in copied_types)
    shift = parse_dt(draft["date"]) - parse_dt(history["event"]["date"])
    for field in ("sales_start", "sales_end"):
        assert parse_dt(paid_copy[field]) == parse_dt(paid_type[field]) + shift

    draft_history = client.get(f"{draft_root}/history", headers=owner).json()
    assert draft_history["tickets"] == draft_history["orders"] == draft_history["check_ins"] == []
    [logged] = client.get(f"{draft_root}/action-log", headers=owner).json()
    assert (logged["action"], logged["entity_id"], logged["actor_id"]) == (
        "event.duplicated", draft["id"], owner_user.id,
    )
    assert f"#{event_id}" in logged["description"]
    assert client.get(f"{root}/action-log", headers=owner).json() == timeline


def test_completed_configuration_is_read_only(client, db, new_event, actors):
    _, owner, _, _, _, _ = actors
    event = new_event(owner)
    root = f"/events/{event['id']}"
    type_id = event["ticket_types"][0]["id"]
    before = client.post(f"{root}/duplicate", headers=owner, json={"date": future_iso(60)})
    assert (before.status_code, before.json()["detail"]["code"]) == (409, "EVENT_NOT_PAST")
    db.get(Event, event["id"]).date = utcnow() - timedelta(days=2)
    db.commit()
    for method, path, data in (
        ("PATCH", root, {"title": "Cannot rename"}),
        ("PUT", root, {"description": None}),
        ("POST", f"{root}/ticket-types", {"name": "Late type", "quantity": 1}),
        ("PATCH", f"{root}/ticket-types/{type_id}", {"quantity": 1}),
        ("POST", f"{root}/unpublish", None),
        ("POST", f"{root}/publish", None),
        ("POST", f"{root}/cancel", None),
    ):
        response = client.request(method, path, headers=owner, json=data)
        assert (response.status_code, response.json()["detail"]["code"]) == (409, "EVENT_COMPLETED")
    bad_date = client.post(f"{root}/duplicate", headers=owner, json={"date": future_iso(-2)})
    assert (bad_date.status_code, bad_date.json()["detail"]["code"]) == (422, "DATE_IN_PAST")
    assert client.get(root, headers=owner).json()["phase"] == "completed"
