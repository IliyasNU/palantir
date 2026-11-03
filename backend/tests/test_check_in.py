"""POST /events/{id}/check-in: the mobile scanner contract (mobile/API.md)."""
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models import CheckIn
from app.routers import check_ins as check_ins_router
from tests.helpers import parse_dt


def detail_code(response):
    return response.json()["detail"]["code"]


def new_request_id():
    return str(uuid.uuid4())


def scan(client, event_id, qr_payload, headers, request_id=None):
    body = {"qr_payload": qr_payload, "request_id": request_id or new_request_id()}
    return client.post(f"/events/{event_id}/check-in", json=body, headers=headers)


def check_in_count(db):
    return db.scalar(select(func.count()).select_from(CheckIn))


@pytest.fixture()
def setup(client, login_as, new_event):
    """A published event with an assigned staff member and one attendee ticket."""
    _, owner = login_as("owner@example.com", "organizer")
    staff_user, staff = login_as("staff@example.com")
    _, attendee = login_as("att@example.com")
    event = new_event(owner)
    assigned = client.post(f"/events/{event['id']}/staff", json={"email": "staff@example.com"}, headers=owner)
    assert assigned.status_code == 201
    ticket = client.post(f"/events/{event['id']}/tickets", headers=attendee).json()
    return {
        "owner": owner, "staff": staff, "staff_user": staff_user, "attendee": attendee,
        "event": event, "ticket": ticket,
    }


# ------------------------------------------------------------------ success and retries
def test_first_scan_checks_in_with_a_complete_receipt(client, db, setup):
    request_id = new_request_id()
    response = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert set(receipt) == {"status", "event_id", "ticket_id", "request_id", "checked_in_at"}
    assert receipt["status"] == "CHECKED_IN"
    assert receipt["event_id"] == setup["event"]["id"]
    assert receipt["ticket_id"] == setup["ticket"]["id"]
    assert receipt["request_id"] == request_id
    parse_dt(receipt["checked_in_at"])
    assert check_in_count(db) == 1

    ticket = client.get(f"/tickets/{setup['ticket']['id']}", headers=setup["attendee"]).json()
    assert parse_dt(ticket["checked_in_at"]) == parse_dt(receipt["checked_in_at"])


def test_retry_with_the_same_request_id_replays_the_receipt(client, db, setup):
    request_id = new_request_id()
    args = (client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)
    first = scan(*args)
    second = scan(*args)
    assert second.status_code == 200
    assert second.json() == first.json()
    assert check_in_count(db) == 1


def test_retry_racing_its_own_twin_still_gets_the_receipt(client, db, setup, monkeypatch):
    """A parallel copy of this request commits between our request_id lookup and the ticket check."""
    request_id = new_request_id()
    args = (client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)
    first = scan(*args)

    real_lookup = check_ins_router._find_by_request_id
    lookups = []

    def miss_first_lookup(session, wanted):
        lookups.append(wanted)
        return None if len(lookups) == 1 else real_lookup(session, wanted)

    monkeypatch.setattr(check_ins_router, "_find_by_request_id", miss_first_lookup)
    second = scan(*args)
    assert second.status_code == 200, second.text
    assert second.json() == first.json()
    assert len(lookups) == 2
    assert check_in_count(db) == 1


def test_new_scan_of_a_used_ticket_is_already_checked_in(client, db, setup):
    scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"])
    response = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"])
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "ALREADY_CHECKED_IN", "message": "Ticket already used"}}
    assert check_in_count(db) == 1


def test_owner_and_admin_can_scan_without_assignment(client, login_as, setup):
    _, admin = login_as("admin@example.com", "admin")
    _, second_attendee = login_as("att2@example.com")
    other_ticket = client.post(f"/events/{setup['event']['id']}/tickets", headers=second_attendee).json()
    assert scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["owner"]).status_code == 200
    assert scan(client, setup["event"]["id"], other_ticket["qr_payload"], admin).status_code == 200


# ------------------------------------------------------------------ request_id reuse
def test_same_request_id_for_another_ticket_is_a_conflict(client, db, login_as, setup):
    _, second_attendee = login_as("att2@example.com")
    other_ticket = client.post(f"/events/{setup['event']['id']}/tickets", headers=second_attendee).json()
    request_id = new_request_id()
    scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)

    response = scan(client, setup["event"]["id"], other_ticket["qr_payload"], setup["staff"], request_id)
    assert response.status_code == 409
    assert detail_code(response) == "REQUEST_ID_CONFLICT"
    assert check_in_count(db) == 1


def test_same_request_id_from_another_staff_member_is_a_conflict(client, login_as, setup):
    _, staff2 = login_as("staff2@example.com")
    client.post(f"/events/{setup['event']['id']}/staff", json={"email": "staff2@example.com"}, headers=setup["owner"])
    request_id = new_request_id()
    scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)

    response = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], staff2, request_id)
    assert response.status_code == 409
    assert detail_code(response) == "REQUEST_ID_CONFLICT"


def test_same_request_id_on_another_event_is_a_conflict(client, new_event, setup):
    other_event = new_event(setup["owner"])
    request_id = new_request_id()
    scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)

    response = scan(client, other_event["id"], setup["ticket"]["qr_payload"], setup["owner"], request_id)
    assert response.status_code == 409
    assert detail_code(response) == "REQUEST_ID_CONFLICT"


# ------------------------------------------------------------------ invalid tickets
def test_unknown_qr_is_an_invalid_ticket(client, db, setup):
    response = scan(client, setup["event"]["id"], "biletflow:ticket:v1:forged", setup["staff"])
    assert response.status_code == 404
    assert detail_code(response) == "INVALID_TICKET"
    assert check_in_count(db) == 0


def test_ticket_for_another_event_is_an_invalid_ticket(client, db, new_event, setup):
    other_event = new_event(setup["owner"])
    other_ticket = client.post(f"/events/{other_event['id']}/tickets", headers=setup["attendee"]).json()
    response = scan(client, setup["event"]["id"], other_ticket["qr_payload"], setup["staff"])
    assert response.status_code == 404
    assert detail_code(response) == "INVALID_TICKET"
    assert check_in_count(db) == 0


def test_unknown_event_is_event_not_found(client, setup):
    response = scan(client, 99999, setup["ticket"]["qr_payload"], setup["staff"])
    assert response.status_code == 404
    assert detail_code(response) == "EVENT_NOT_FOUND"


# ------------------------------------------------------------------ access
def test_people_without_access_get_403_and_keep_their_session(client, login_as, db, setup):
    _, stranger = login_as("stranger@example.com", "organizer")
    for headers in (stranger, setup["attendee"]):
        response = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], headers)
        assert response.status_code == 403
        assert detail_code(response) == "FORBIDDEN"
        assert client.get("/auth/me", headers=headers).status_code == 200
    assert check_in_count(db) == 0


def test_revoked_staff_gets_403_even_when_retrying(client, db, setup):
    request_id = new_request_id()
    args = (client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)
    assert scan(*args).status_code == 200
    client.delete(f"/events/{setup['event']['id']}/staff/{setup['staff_user'].id}", headers=setup["owner"])

    response = scan(*args)
    assert response.status_code == 403
    assert detail_code(response) == "FORBIDDEN"
    assert check_in_count(db) == 1


def test_anonymous_or_bad_token_is_401(client, setup):
    assert scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], {}).status_code == 401
    bad = {"Authorization": "Bearer nope"}
    assert scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], bad).status_code == 401


# ------------------------------------------------------------------ event status
def test_cancelled_event_admits_nobody_but_replays_earlier_receipts(client, db, login_as, setup):
    _, second_attendee = login_as("att2@example.com")
    other_ticket = client.post(f"/events/{setup['event']['id']}/tickets", headers=second_attendee).json()
    request_id = new_request_id()
    first = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)
    client.post(f"/events/{setup['event']['id']}/cancel", headers=setup["owner"])

    response = scan(client, setup["event"]["id"], other_ticket["qr_payload"], setup["staff"])
    assert response.status_code == 409
    assert detail_code(response) == "EVENT_CANCELLED"
    replay = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)
    assert replay.json() == first.json()
    assert check_in_count(db) == 1


def test_draft_event_admits_nobody(client, new_event, setup):
    draft = new_event(setup["owner"], publish=False)
    client.post(f"/events/{draft['id']}/staff", json={"email": "staff@example.com"}, headers=setup["owner"])
    response = scan(client, draft["id"], "biletflow:ticket:v1:anything", setup["staff"])
    assert response.status_code == 409
    assert detail_code(response) == "EVENT_NOT_PUBLISHED"


# ------------------------------------------------------------------ validation
@pytest.mark.parametrize(
    "body",
    [
        {"qr_payload": "x"},
        {"request_id": "f59c8ead-2eea-4ae9-b2cd-3cc2c047b049"},
        {"qr_payload": "", "request_id": "f59c8ead-2eea-4ae9-b2cd-3cc2c047b049"},
        {"qr_payload": "x", "request_id": "not-a-uuid"},
        {"qr_payload": "x", "request_id": "F59C8EAD-2EEA-4AE9-B2CD-3CC2C047B049"},
        {"qr_payload": "x" * 513, "request_id": "f59c8ead-2eea-4ae9-b2cd-3cc2c047b049"},
    ],
)
def test_malformed_requests_are_422(client, setup, body):
    response = client.post(f"/events/{setup['event']['id']}/check-in", json=body, headers=setup["staff"])
    assert response.status_code == 422


# ------------------------------------------------------------------ database guarantees
def test_database_allows_one_check_in_per_ticket(client, db, setup):
    scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"])
    db.add(
        CheckIn(
            ticket_id=setup["ticket"]["id"],
            event_id=setup["event"]["id"],
            staff_id=setup["staff_user"].id,
            request_id=uuid.uuid4(),
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
