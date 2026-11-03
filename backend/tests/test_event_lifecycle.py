"""Draft -> published -> cancelled, public reads and the capacity guard."""
import pytest

from app.models import Event
from tests.helpers import future_iso


def detail_code(response):
    return response.json()["detail"]["code"]


# ------------------------------------------------------------------ status changes
def test_new_event_is_a_draft_with_no_tickets(login_as, new_event):
    _, headers = login_as("org@example.com", "organizer")
    event = new_event(headers, publish=False)
    assert event["status"] == "draft"
    assert event["tickets_issued"] == 0


def test_owner_publishes_and_publishing_again_is_a_no_op(client, login_as, new_event):
    _, headers = login_as("org@example.com", "organizer")
    event = new_event(headers, publish=False)
    for _ in range(2):
        response = client.post(f"/events/{event['id']}/publish", headers=headers)
        assert response.status_code == 200
        assert response.json()["status"] == "published"


def test_cancel_is_final(client, login_as, new_event, db):
    _, headers = login_as("org@example.com", "organizer")
    event = new_event(headers)
    for _ in range(2):
        response = client.post(f"/events/{event['id']}/cancel", headers=headers)
        assert response.status_code == 200
        assert response.json()["status"] == "cancelled"

    response = client.post(f"/events/{event['id']}/publish", headers=headers)
    assert response.status_code == 409
    assert detail_code(response) == "EVENT_CANCELLED"
    assert db.get(Event, event["id"]).status == "cancelled"


def test_draft_can_be_cancelled(client, login_as, new_event):
    _, headers = login_as("org@example.com", "organizer")
    event = new_event(headers, publish=False)
    assert client.post(f"/events/{event['id']}/cancel", headers=headers).json()["status"] == "cancelled"


@pytest.mark.parametrize("action", ["publish", "cancel"])
def test_only_owner_or_admin_changes_status(client, login_as, new_event, action):
    _, owner = login_as("owner@example.com", "organizer")
    _, other = login_as("other@example.com", "organizer")
    _, attendee = login_as("att@example.com")
    _, admin = login_as("admin@example.com", "admin")
    event = new_event(owner, publish=False)
    url = f"/events/{event['id']}/{action}"

    assert client.post(url).status_code == 401
    assert client.post(url, headers=other).status_code == 403
    assert client.post(url, headers=attendee).status_code == 403
    assert client.post(url, headers=admin).status_code == 200


@pytest.mark.parametrize("action", ["publish", "cancel"])
def test_status_change_on_unknown_event_is_404(client, login_as, action):
    _, headers = login_as("org@example.com", "organizer")
    response = client.post(f"/events/99999/{action}", headers=headers)
    assert response.status_code == 404
    assert detail_code(response) == "EVENT_NOT_FOUND"


def test_status_and_counter_cannot_be_edited_directly(client, login_as, new_event):
    _, headers = login_as("org@example.com", "organizer")
    event = new_event(headers, publish=False)
    response = client.patch(
        f"/events/{event['id']}", json={"status": "published", "tickets_issued": 99}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["status"] == "draft"
    assert response.json()["tickets_issued"] == 0


# ------------------------------------------------------------------ public reads
def test_public_list_shows_only_published_events_soonest_first(client, login_as, new_event):
    _, headers = login_as("org@example.com", "organizer")
    later = new_event(headers, date=future_iso(days=60), title="Later event")
    sooner = new_event(headers, date=future_iso(days=5), title="Sooner event")
    new_event(headers, publish=False, title="Draft event")
    cancelled = new_event(headers, title="Cancelled event")
    client.post(f"/events/{cancelled['id']}/cancel", headers=headers)

    response = client.get("/events")
    assert response.status_code == 200
    assert [event["id"] for event in response.json()] == [sooner["id"], later["id"]]


def test_public_list_is_empty_without_published_events(client):
    assert client.get("/events").json() == []


def test_anyone_reads_published_and_cancelled_events(client, login_as, new_event):
    _, owner = login_as("owner@example.com", "organizer")
    _, attendee = login_as("att@example.com")
    published = new_event(owner)
    cancelled = new_event(owner)
    client.post(f"/events/{cancelled['id']}/cancel", headers=owner)

    for event in (published, cancelled):
        assert client.get(f"/events/{event['id']}").status_code == 200
        assert client.get(f"/events/{event['id']}", headers=attendee).status_code == 200


def test_draft_is_visible_only_to_owner_and_admin(client, login_as, new_event):
    _, owner = login_as("owner@example.com", "organizer")
    _, attendee = login_as("att@example.com")
    _, admin = login_as("admin@example.com", "admin")
    draft = new_event(owner, publish=False)
    url = f"/events/{draft['id']}"

    assert client.get(url).status_code == 404
    assert client.get(url, headers=attendee).status_code == 404
    assert client.get(url, headers=owner).status_code == 200
    assert client.get(url, headers=admin).status_code == 200


def test_bad_token_on_public_read_is_401_not_anonymous(client, login_as, new_event):
    _, owner = login_as("owner@example.com", "organizer")
    event = new_event(owner)
    response = client.get(f"/events/{event['id']}", headers={"Authorization": "Bearer not-a-token"})
    assert response.status_code == 401


def test_my_events_lists_own_events_in_every_status(client, login_as, new_event):
    _, owner = login_as("owner@example.com", "organizer")
    _, other = login_as("other@example.com", "organizer")
    draft = new_event(owner, publish=False)
    published = new_event(owner)
    new_event(other)

    response = client.get("/events/mine", headers=owner)
    assert response.status_code == 200
    assert {event["id"] for event in response.json()} == {draft["id"], published["id"]}


def test_my_events_is_for_organizers(client, login_as):
    _, attendee = login_as("att@example.com")
    assert client.get("/events/mine").status_code == 401
    assert client.get("/events/mine", headers=attendee).status_code == 403


# ------------------------------------------------------------------ capacity guard
def test_capacity_cannot_drop_below_issued_tickets(client, login_as, new_event, db):
    _, owner = login_as("owner@example.com", "organizer")
    event = new_event(owner, capacity=5)
    for index in range(2):
        _, headers = login_as(f"att{index}@example.com")
        assert client.post(f"/events/{event['id']}/tickets", headers=headers).status_code == 201

    response = client.patch(f"/events/{event['id']}", json={"capacity": 1}, headers=owner)
    assert response.status_code == 409
    assert detail_code(response) == "CAPACITY_BELOW_ISSUED"
    db.expire_all()
    assert db.get(Event, event["id"]).capacity == 5

    response = client.patch(f"/events/{event['id']}", json={"capacity": 2}, headers=owner)
    assert response.status_code == 200
    assert response.json()["capacity"] == 2
