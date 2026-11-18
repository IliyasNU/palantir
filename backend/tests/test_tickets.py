"""Claiming free tickets and reading them back."""
import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models import Event, Ticket
from app.routers.tickets import QR_PAYLOAD_PREFIX


def detail_code(response):
    return response.json()["detail"]["code"]


def claim(client, event_id, headers):
    return client.post(f"/events/{event_id}/tickets", headers=headers)


@pytest.fixture()
def owner(login_as):
    return login_as("owner@example.com", "organizer")[1]


# ------------------------------------------------------------------ claiming
def test_attendee_claims_a_ticket(client, login_as, owner, new_event, db):
    attendee, headers = login_as("att@example.com")
    event = new_event(owner)

    response = claim(client, event["id"], headers)
    assert response.status_code == 201, response.text
    ticket = response.json()
    assert ticket["event_id"] == event["id"]
    assert ticket["attendee_id"] == attendee.id
    assert ticket["qr_payload"].startswith(QR_PAYLOAD_PREFIX)
    assert len(ticket["qr_payload"]) > len(QR_PAYLOAD_PREFIX) + 20
    assert ticket["checked_in_at"] is None
    assert ticket["event"] == {
        "id": event["id"],
        "title": event["title"],
        "date": event["date"],
        "location": event["location"],
        "status": "published",
    }
    assert db.get(Event, event["id"]).tickets_issued == 1


def test_claiming_again_returns_the_same_ticket(client, login_as, owner, new_event, db):
    _, headers = login_as("att@example.com")
    event = new_event(owner)
    first = claim(client, event["id"], headers)
    second = claim(client, event["id"], headers)
    assert (first.status_code, second.status_code) == (201, 200)
    assert second.json() == first.json()
    db.expire_all()
    assert db.get(Event, event["id"]).tickets_issued == 1
    assert db.scalar(select(func.count()).select_from(Ticket)) == 1


def test_each_ticket_gets_a_different_qr_payload(client, login_as, owner, new_event):
    event = new_event(owner)
    payloads = set()
    for index in range(5):
        _, headers = login_as(f"att{index}@example.com")
        payloads.add(claim(client, event["id"], headers).json()["qr_payload"])
    assert len(payloads) == 5


def test_last_seat_then_sold_out(client, login_as, owner, new_event, db):
    event = new_event(owner, capacity=2)
    statuses = []
    for index in range(3):
        _, headers = login_as(f"att{index}@example.com")
        statuses.append(claim(client, event["id"], headers))
    assert [response.status_code for response in statuses] == [201, 201, 409]
    assert detail_code(statuses[-1]) == "SOLD_OUT"
    db.expire_all()
    assert db.get(Event, event["id"]).tickets_issued == 2
    assert db.scalar(select(func.count()).select_from(Ticket)) == 2


def test_ticket_holder_still_gets_their_ticket_when_sold_out(client, login_as, owner, new_event):
    _, headers = login_as("att@example.com")
    event = new_event(owner, capacity=1)
    first = claim(client, event["id"], headers)
    assert claim(client, event["id"], headers).json()["id"] == first.json()["id"]


def test_draft_is_hidden_from_attendees_and_not_open_for_its_owner(client, login_as, owner, new_event):
    _, headers = login_as("att@example.com")
    draft = new_event(owner, publish=False)

    response = claim(client, draft["id"], headers)
    assert response.status_code == 404
    assert detail_code(response) == "EVENT_NOT_FOUND"

    response = claim(client, draft["id"], owner)
    assert response.status_code == 409
    assert detail_code(response) == "EVENT_NOT_PUBLISHED"


def test_cancelled_event_issues_no_tickets_but_existing_ones_remain(client, login_as, owner, new_event, db):
    _, holder = login_as("holder@example.com")
    _, latecomer = login_as("late@example.com")
    event = new_event(owner)
    ticket = claim(client, event["id"], holder).json()
    client.post(f"/events/{event['id']}/cancel", headers=owner)

    response = claim(client, event["id"], latecomer)
    assert response.status_code == 409
    assert detail_code(response) == "EVENT_CANCELLED"
    assert claim(client, event["id"], holder).json()["id"] == ticket["id"]
    db.expire_all()
    assert db.get(Event, event["id"]).tickets_issued == 1


def test_claim_on_unknown_event_is_404(client, login_as):
    _, headers = login_as("att@example.com")
    response = claim(client, 99999, headers)
    assert response.status_code == 404
    assert response.json() == {"detail": {"code": "EVENT_NOT_FOUND", "message": "Event not found"}}


def test_claim_needs_login(client, owner, new_event):
    assert claim(client, new_event(owner)["id"], {}).status_code == 401


# ------------------------------------------------------------------ reading
def test_my_tickets_lists_only_mine_newest_first(client, login_as, owner, new_event):
    _, mine = login_as("me@example.com")
    _, theirs = login_as("them@example.com")
    first_event, second_event = new_event(owner), new_event(owner)
    first = claim(client, first_event["id"], mine).json()
    second = claim(client, second_event["id"], mine).json()
    claim(client, first_event["id"], theirs)

    response = client.get("/tickets/me", headers=mine)
    assert response.status_code == 200
    assert [ticket["id"] for ticket in response.json()] == [second["id"], first["id"]]


def test_my_tickets_is_empty_at_first(client, login_as):
    _, headers = login_as("att@example.com")
    assert client.get("/tickets/me", headers=headers).json() == []
    assert client.get("/tickets/me").status_code == 401


def test_ticket_reloads_with_the_same_qr_payload(client, login_as, owner, new_event):
    _, headers = login_as("att@example.com")
    ticket = claim(client, new_event(owner)["id"], headers).json()
    response = client.get(f"/tickets/{ticket['id']}", headers=headers)
    assert response.status_code == 200
    assert response.json() == ticket


def test_other_peoples_tickets_look_missing_except_to_admins(client, login_as, owner, new_event):
    _, holder = login_as("holder@example.com")
    _, stranger = login_as("stranger@example.com")
    _, admin = login_as("admin@example.com", "admin")
    ticket = claim(client, new_event(owner)["id"], holder).json()

    response = client.get(f"/tickets/{ticket['id']}", headers=stranger)
    assert response.status_code == 404
    assert detail_code(response) == "TICKET_NOT_FOUND"
    assert client.get(f"/tickets/{ticket['id']}", headers=owner).status_code == 404
    assert client.get(f"/tickets/{ticket['id']}", headers=admin).status_code == 200
    assert client.get("/tickets/99999", headers=holder).status_code == 404
    assert client.get(f"/tickets/{ticket['id']}").status_code == 401


# ------------------------------------------------------------------ database guarantees
def test_database_rejects_overselling(db, login_as, owner, new_event, client):
    event_id = new_event(owner, capacity=1)["id"]
    event = db.get(Event, event_id)
    event.tickets_issued = 2
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_database_rejects_a_second_ticket_for_the_same_attendee(db, login_as, owner, new_event, client):
    attendee, headers = login_as("att@example.com")
    event = new_event(owner)
    first = claim(client, event["id"], headers).json()
    db.add(Ticket(event_id=event["id"], attendee_id=attendee.id, ticket_type_id=first["ticket_type_id"],
                  qr_payload="biletflow:ticket:v1:other"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
