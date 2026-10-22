from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import Event
from tests.helpers import event_payload, parse_dt


def make_organizer(create_user, auth_header, email="org@example.com"):
    user = create_user(email, role="organizer")
    return user, auth_header(email)


def create_event(client, headers, **overrides):
    response = client.post("/events", json=event_payload(**overrides), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


# ------------------------------------------------------------------ create
def test_organizer_creates_event(client, create_user, auth_header, db):
    user, headers = make_organizer(create_user, auth_header)
    payload = event_payload()
    response = client.post("/events", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["organizer_id"] == user.id
    assert body["title"] == payload["title"]
    assert body["description"] == payload["description"]
    assert body["location"] == payload["location"]
    assert body["capacity"] == payload["capacity"]
    assert parse_dt(body["date"]) == parse_dt(payload["date"])

    stored = db.get(Event, body["id"])
    assert stored is not None and stored.organizer_id == user.id


def test_event_date_is_converted_to_utc(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    body = create_event(client, headers, date="2030-05-01T18:00:00+06:00")  # Astana time
    assert parse_dt(body["date"]) == datetime(2030, 5, 1, 12, 0, tzinfo=timezone.utc)


def test_naive_event_date_is_treated_as_utc(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    body = create_event(client, headers, date="2030-05-01T18:00:00")
    assert parse_dt(body["date"]) == datetime(2030, 5, 1, 18, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "bad",
    [
        {"capacity": 0},
        {"capacity": -5},
        {"capacity": "many"},
        {"title": "ab"},
        {"title": ""},
        {"location": ""},
        {"date": "not-a-date"},
    ],
)
def test_invalid_event_data_is_rejected(client, create_user, auth_header, bad):
    _, headers = make_organizer(create_user, auth_header)
    response = client.post("/events", json=event_payload(**bad), headers=headers)
    assert response.status_code == 422


def test_missing_required_fields_are_rejected(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    assert client.post("/events", json={"title": "Only a title"}, headers=headers).status_code == 422


def test_attendee_cannot_create_event(client, create_user, auth_header):
    create_user("att@example.com", role="attendee")
    response = client.post("/events", json=event_payload(), headers=auth_header("att@example.com"))
    assert response.status_code == 403


def test_anonymous_cannot_create_event(client):
    assert client.post("/events", json=event_payload()).status_code == 401


def test_database_rejects_non_positive_capacity(db, create_user):
    organizer = create_user("org@example.com", role="organizer")
    db.add(
        Event(
            organizer_id=organizer.id,
            title="Bad event",
            location="Nowhere",
            date=datetime.now(timezone.utc),
            capacity=0,
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


# ------------------------------------------------------------------ read
def test_owner_can_read_event(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    event_id = create_event(client, headers)["id"]
    response = client.get(f"/events/{event_id}", headers=headers)
    assert response.status_code == 200
    assert response.json()["id"] == event_id


def test_other_organizer_cannot_read_event(client, create_user, auth_header):
    _, owner_headers = make_organizer(create_user, auth_header, "owner@example.com")
    _, other_headers = make_organizer(create_user, auth_header, "other@example.com")
    event_id = create_event(client, owner_headers)["id"]
    assert client.get(f"/events/{event_id}", headers=other_headers).status_code == 403


def test_admin_can_read_any_event(client, create_user, auth_header):
    _, owner_headers = make_organizer(create_user, auth_header, "owner@example.com")
    create_user("admin@example.com", role="admin")
    event_id = create_event(client, owner_headers)["id"]
    assert client.get(f"/events/{event_id}", headers=auth_header("admin@example.com")).status_code == 200


def test_unknown_event_is_404(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    assert client.get("/events/99999", headers=headers).status_code == 404


# ------------------------------------------------------------------ edit
@pytest.mark.parametrize("method", ["put", "patch"])
def test_owner_can_edit_event(client, create_user, auth_header, method):
    _, headers = make_organizer(create_user, auth_header)
    created = create_event(client, headers)
    response = client.request(
        method.upper(),
        f"/events/{created['id']}",
        json={"title": "Renamed event", "capacity": 200},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title"] == "Renamed event"
    assert body["capacity"] == 200
    assert body["location"] == created["location"]  # untouched
    assert body["description"] == created["description"]  # untouched
    assert parse_dt(body["updated_at"]) >= parse_dt(body["created_at"])


def test_edit_can_clear_description(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    event_id = create_event(client, headers)["id"]
    response = client.patch(f"/events/{event_id}", json={"description": None}, headers=headers)
    assert response.status_code == 200
    assert response.json()["description"] is None


@pytest.mark.parametrize("bad", [{"title": None}, {"capacity": 0}, {"date": None}, {"location": None}])
def test_edit_with_invalid_data_is_rejected(client, create_user, auth_header, bad):
    _, headers = make_organizer(create_user, auth_header)
    event_id = create_event(client, headers)["id"]
    assert client.patch(f"/events/{event_id}", json=bad, headers=headers).status_code == 422


def test_other_organizer_cannot_edit_event(client, create_user, auth_header):
    _, owner_headers = make_organizer(create_user, auth_header, "owner@example.com")
    _, other_headers = make_organizer(create_user, auth_header, "other@example.com")
    event_id = create_event(client, owner_headers)["id"]
    response = client.patch(f"/events/{event_id}", json={"title": "Hijacked"}, headers=other_headers)
    assert response.status_code == 403
    assert client.get(f"/events/{event_id}", headers=owner_headers).json()["title"] == "Palantir Demo Day"


def test_attendee_cannot_edit_event(client, create_user, auth_header):
    _, owner_headers = make_organizer(create_user, auth_header, "owner@example.com")
    create_user("att@example.com", role="attendee")
    event_id = create_event(client, owner_headers)["id"]
    response = client.patch(f"/events/{event_id}", json={"title": "Nope nope"}, headers=auth_header("att@example.com"))
    assert response.status_code == 403


def test_admin_can_edit_any_event(client, create_user, auth_header):
    _, owner_headers = make_organizer(create_user, auth_header, "owner@example.com")
    create_user("admin@example.com", role="admin")
    event_id = create_event(client, owner_headers)["id"]
    response = client.patch(
        f"/events/{event_id}", json={"title": "Edited by admin"}, headers=auth_header("admin@example.com")
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Edited by admin"


def test_editing_unknown_event_is_404(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    assert client.patch("/events/99999", json={"title": "Whatever"}, headers=headers).status_code == 404
