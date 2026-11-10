"""Cancelled and refunded tickets, and undoing a check-in (contract: mobile/API.md)."""
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models import CheckIn, Event, Ticket
from tests.helpers import parse_dt


def detail_code(response):
    return response.json()["detail"]["code"]


def new_request_id():
    return str(uuid.uuid4())


def scan(client, event_id, qr_payload, headers, request_id=None):
    body = {"qr_payload": qr_payload, "request_id": request_id or new_request_id()}
    return client.post(f"/events/{event_id}/check-in", json=body, headers=headers)


def undo(client, event_id, check_in_id, headers, request_id=None):
    body = {"request_id": request_id or new_request_id()}
    return client.post(f"/events/{event_id}/check-ins/{check_in_id}/undo", json=body, headers=headers)


def attendance(client, event_id, headers):
    response = client.get(f"/events/{event_id}/attendance", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def found(client, event_id, headers, q="attendee"):
    response = client.get(f"/events/{event_id}/attendees", params={"q": q}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def check_in_rows(db, ticket_id):
    db.expire_all()
    return db.scalars(select(CheckIn).where(CheckIn.ticket_id == ticket_id).order_by(CheckIn.id)).all()


def issued(db, event_id):
    db.expire_all()
    return db.get(Event, event_id).tickets_issued


@pytest.fixture()
def setup(client, login_as, new_event):
    """A published event with its organizer, one assigned staff member and one attendee ticket."""
    _, owner = login_as("owner@example.com", "organizer")
    staff_user, staff = login_as("staff@example.com")
    attendee_user, attendee = login_as("attendee@example.com")
    event = new_event(owner, capacity=5)
    assigned = client.post(f"/events/{event['id']}/staff", json={"email": "staff@example.com"}, headers=owner)
    assert assigned.status_code == 201, assigned.text
    ticket = client.post(f"/events/{event['id']}/tickets", headers=attendee).json()
    return {
        "owner": owner, "staff": staff, "staff_user": staff_user, "attendee": attendee,
        "attendee_user": attendee_user, "event": event, "ticket": ticket,
    }


@pytest.fixture()
def admitted(client, setup):
    """The setup ticket, checked in by the assigned staff member."""
    request_id = new_request_id()
    response = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"], request_id)
    assert response.status_code == 200, response.text
    return {**setup, "receipt": response.json(), "scan_request_id": request_id}


# ------------------------------------------------------------------ ticket status is visible
def test_new_ticket_is_active_everywhere(client, setup):
    assert setup["ticket"]["status"] == "active"
    assert client.get(f"/tickets/{setup['ticket']['id']}", headers=setup["attendee"]).json()["status"] == "active"
    assert client.get("/tickets/me", headers=setup["attendee"]).json()[0]["status"] == "active"
    assert found(client, setup["event"]["id"], setup["staff"])[0]["status"] == "active"


# ------------------------------------------------------------------ cancelling a ticket
def test_attendee_cancels_their_ticket_and_the_seat_is_released(client, db, setup):
    ticket_id, event_id = setup["ticket"]["id"], setup["event"]["id"]
    response = client.post(f"/tickets/{ticket_id}/cancel", headers=setup["attendee"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "cancelled"
    assert body["id"] == ticket_id and body["qr_payload"] == setup["ticket"]["qr_payload"]
    assert body["checked_in_at"] is None
    assert issued(db, event_id) == 0

    stored = db.get(Ticket, ticket_id)
    assert stored.status_changed_by_id == setup["attendee_user"].id and stored.status_changed_at is not None
    assert attendance(client, event_id, setup["staff"]) == {
        "event_id": event_id, "capacity": 5, "tickets_issued": 0, "checked_in": 0,
    }
    result = found(client, event_id, setup["staff"])[0]
    assert (result["status"], result["checked_in_at"], result["check_in_id"]) == ("cancelled", None, None)


def test_cancelling_twice_changes_nothing_more(client, db, setup):
    first = client.post(f"/tickets/{setup['ticket']['id']}/cancel", headers=setup["attendee"])
    second = client.post(f"/tickets/{setup['ticket']['id']}/cancel", headers=setup["owner"])
    assert second.status_code == 200
    assert second.json() == first.json()
    assert issued(db, setup["event"]["id"]) == 0
    assert db.get(Ticket, setup["ticket"]["id"]).status_changed_by_id == setup["attendee_user"].id


@pytest.mark.parametrize("role", ["organizer", "admin"])
def test_event_managers_can_cancel_a_ticket(client, login_as, setup, role):
    headers = setup["owner"] if role == "organizer" else login_as("admin@example.com", "admin")[1]
    response = client.post(f"/tickets/{setup['ticket']['id']}/cancel", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"


@pytest.mark.parametrize("action", ["cancel", "refund"])
def test_other_people_cannot_see_or_change_the_ticket(client, db, login_as, setup, action):
    _, stranger = login_as("stranger@example.com")
    _, other_organizer = login_as("other-organizer@example.com", "organizer")
    for headers in (stranger, other_organizer, setup["staff"]):
        response = client.post(f"/tickets/{setup['ticket']['id']}/{action}", headers=headers)
        assert response.status_code == 404
        assert detail_code(response) == "TICKET_NOT_FOUND"
    assert client.post(f"/tickets/99999/{action}", headers=setup["owner"]).status_code == 404
    assert client.post(f"/tickets/{setup['ticket']['id']}/{action}").status_code == 401
    assert db.get(Ticket, setup["ticket"]["id"]).status == "active"


def test_cancelled_ticket_is_rejected_at_the_door(client, db, setup):
    client.post(f"/tickets/{setup['ticket']['id']}/cancel", headers=setup["attendee"])
    response = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"])
    assert response.status_code == 409
    assert detail_code(response) == "TICKET_CANCELLED"
    assert check_in_rows(db, setup["ticket"]["id"]) == []


def test_released_seat_goes_to_someone_else_and_the_old_ticket_stays_cancelled(client, login_as, new_event, setup):
    _, first = login_as("first@example.com")
    _, second = login_as("second@example.com")
    event = new_event(setup["owner"], capacity=1)
    ticket = client.post(f"/events/{event['id']}/tickets", headers=first).json()
    assert detail_code(client.post(f"/events/{event['id']}/tickets", headers=second)) == "SOLD_OUT"

    client.post(f"/tickets/{ticket['id']}/cancel", headers=first)
    assert client.post(f"/events/{event['id']}/tickets", headers=second).status_code == 201
    again = client.post(f"/events/{event['id']}/tickets", headers=first)
    assert again.status_code == 200
    assert (again.json()["id"], again.json()["status"]) == (ticket["id"], "cancelled")
    assert client.get(f"/events/{event['id']}").json()["tickets_issued"] == 1


# ------------------------------------------------------------------ marking a ticket refunded
def test_organizer_marks_a_ticket_refunded_and_it_is_rejected_at_the_door(client, db, setup):
    response = client.post(f"/tickets/{setup['ticket']['id']}/refund", headers=setup["owner"])
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "refunded"
    assert issued(db, setup["event"]["id"]) == 0
    assert client.post(f"/tickets/{setup['ticket']['id']}/refund", headers=setup["owner"]).json() == response.json()
    assert issued(db, setup["event"]["id"]) == 0

    rejected = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["staff"])
    assert rejected.status_code == 409
    assert detail_code(rejected) == "TICKET_REFUNDED"
    assert check_in_rows(db, setup["ticket"]["id"]) == []
    assert found(client, setup["event"]["id"], setup["staff"])[0]["status"] == "refunded"


def test_attendee_cannot_mark_their_own_ticket_refunded(client, db, setup):
    response = client.post(f"/tickets/{setup['ticket']['id']}/refund", headers=setup["attendee"])
    assert response.status_code == 403
    assert detail_code(response) == "FORBIDDEN"
    assert db.get(Ticket, setup["ticket"]["id"]).status == "active"


def test_final_states_do_not_change_into_each_other(client, db, login_as, setup):
    _, second = login_as("second@example.com")
    other = client.post(f"/events/{setup['event']['id']}/tickets", headers=second).json()
    client.post(f"/tickets/{setup['ticket']['id']}/cancel", headers=setup["attendee"])
    client.post(f"/tickets/{other['id']}/refund", headers=setup["owner"])

    refund_cancelled = client.post(f"/tickets/{setup['ticket']['id']}/refund", headers=setup["owner"])
    cancel_refunded = client.post(f"/tickets/{other['id']}/cancel", headers=second)
    assert (refund_cancelled.status_code, detail_code(refund_cancelled)) == (409, "TICKET_CANCELLED")
    assert (cancel_refunded.status_code, detail_code(cancel_refunded)) == (409, "TICKET_REFUNDED")
    assert issued(db, setup["event"]["id"]) == 0


@pytest.mark.parametrize("action", ["cancel", "refund"])
def test_a_checked_in_ticket_cannot_be_closed_until_the_check_in_is_undone(client, db, admitted, action):
    response = client.post(f"/tickets/{admitted['ticket']['id']}/{action}", headers=admitted["owner"])
    assert response.status_code == 409
    assert detail_code(response) == "TICKET_CHECKED_IN"
    assert db.get(Ticket, admitted["ticket"]["id"]).status == "active"
    assert issued(db, admitted["event"]["id"]) == 1

    assert undo(client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admitted["owner"]).status_code == 200
    closed = client.post(f"/tickets/{admitted['ticket']['id']}/{action}", headers=admitted["owner"])
    assert closed.status_code == 200
    assert attendance(client, admitted["event"]["id"], admitted["staff"])["checked_in"] == 0


def test_event_state_is_reported_before_the_ticket_state(client, setup):
    client.post(f"/tickets/{setup['ticket']['id']}/cancel", headers=setup["attendee"])
    client.post(f"/events/{setup['event']['id']}/cancel", headers=setup["owner"])
    response = scan(client, setup["event"]["id"], setup["ticket"]["qr_payload"], setup["owner"])
    assert detail_code(response) == "EVENT_CANCELLED"


def test_another_events_closed_ticket_is_still_just_an_invalid_ticket(client, new_event, setup):
    other = new_event(setup["owner"])
    client.post(f"/tickets/{setup['ticket']['id']}/cancel", headers=setup["attendee"])
    response = scan(client, other["id"], setup["ticket"]["qr_payload"], setup["owner"])
    assert (response.status_code, detail_code(response)) == (404, "INVALID_TICKET")


# ------------------------------------------------------------------ undo: who may
def test_organizer_undoes_a_check_in_and_history_is_kept(client, db, admitted):
    event_id, check_in_id = admitted["event"]["id"], admitted["receipt"]["check_in_id"]
    request_id = new_request_id()
    response = undo(client, event_id, check_in_id, admitted["owner"], request_id)
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert set(receipt) == {"status", "event_id", "ticket_id", "check_in_id", "request_id", "undone_at"}
    assert receipt["status"] == "UNDONE"
    assert (receipt["event_id"], receipt["ticket_id"], receipt["check_in_id"]) == (
        event_id, admitted["ticket"]["id"], check_in_id,
    )
    assert receipt["request_id"] == request_id
    parse_dt(receipt["undone_at"])

    rows = check_in_rows(db, admitted["ticket"]["id"])
    assert len(rows) == 1 and rows[0].undone_at is not None
    assert str(rows[0].request_id) == admitted["scan_request_id"]  # the original receipt key survives
    assert attendance(client, event_id, admitted["staff"])["checked_in"] == 0
    assert client.get(f"/tickets/{admitted['ticket']['id']}", headers=admitted["attendee"]).json()["checked_in_at"] is None
    result = found(client, event_id, admitted["staff"])[0]
    assert (result["status"], result["checked_in_at"], result["check_in_id"]) == ("active", None, None)


def test_admin_may_undo(client, login_as, admitted):
    _, admin = login_as("admin@example.com", "admin")
    response = undo(client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admin)
    assert response.status_code == 200, response.text


def test_assigned_staff_may_scan_but_not_undo(client, db, admitted):
    response = undo(client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admitted["staff"])
    assert response.status_code == 403
    assert detail_code(response) == "UNDO_NOT_ALLOWED"
    assert check_in_rows(db, admitted["ticket"]["id"])[0].undone_at is None
    assert attendance(client, admitted["event"]["id"], admitted["staff"])["checked_in"] == 1


def test_people_without_event_access_get_the_plain_forbidden(client, login_as, admitted):
    _, stranger = login_as("stranger@example.com")
    _, other_organizer = login_as("other-organizer@example.com", "organizer")
    check_in_id = admitted["receipt"]["check_in_id"]
    for headers in (stranger, other_organizer, admitted["attendee"]):
        response = undo(client, admitted["event"]["id"], check_in_id, headers)
        assert (response.status_code, detail_code(response)) == (403, "FORBIDDEN")
    client.delete(
        f"/events/{admitted['event']['id']}/staff/{admitted['staff_user'].id}", headers=admitted["owner"]
    )
    revoked = undo(client, admitted["event"]["id"], check_in_id, admitted["staff"])
    assert (revoked.status_code, detail_code(revoked)) == (403, "FORBIDDEN")
    body = {"request_id": new_request_id()}
    assert client.post(f"/events/{admitted['event']['id']}/check-ins/{check_in_id}/undo", json=body).status_code == 401


def test_undo_targets_must_exist_at_this_event(client, new_event, admitted):
    other = new_event(admitted["owner"])
    check_in_id = admitted["receipt"]["check_in_id"]
    for event_id, target, code in (
        (admitted["event"]["id"], 99999, "CHECK_IN_NOT_FOUND"),
        (other["id"], check_in_id, "CHECK_IN_NOT_FOUND"),
        (99999, check_in_id, "EVENT_NOT_FOUND"),
    ):
        response = undo(client, event_id, target, admitted["owner"])
        assert (response.status_code, detail_code(response)) == (404, code)


@pytest.mark.parametrize("request_id", ["", "not-a-uuid", "F59C8EAD-2EEA-4AE9-B2CD-3CC2C047B049"])
def test_undo_needs_a_canonical_request_id(client, admitted, request_id):
    path = f"/events/{admitted['event']['id']}/check-ins/{admitted['receipt']['check_in_id']}/undo"
    assert client.post(path, json={"request_id": request_id}, headers=admitted["owner"]).status_code == 422
    assert client.post(path, json={}, headers=admitted["owner"]).status_code == 422


# ------------------------------------------------------------------ undo: retries
def test_retrying_an_undo_returns_the_same_receipt(client, db, admitted):
    request_id = new_request_id()
    args = (client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admitted["owner"], request_id)
    first = undo(*args)
    second = undo(*args)
    assert second.status_code == 200
    assert second.json() == first.json()
    assert len(check_in_rows(db, admitted["ticket"]["id"])) == 1


def test_a_second_undo_request_is_told_it_was_already_undone(client, admitted):
    args = (client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admitted["owner"])
    first = undo(*args)
    again = undo(*args)
    assert (again.status_code, detail_code(again)) == (409, "CHECK_IN_ALREADY_UNDONE")
    assert undo(*args, first.json()["request_id"]).json() == first.json()  # the original request still replays


def test_an_undo_request_id_belongs_to_one_actor_and_one_check_in(client, login_as, admitted):
    _, admin = login_as("admin@example.com", "admin")
    _, second = login_as("second@example.com")
    other_ticket = client.post(f"/events/{admitted['event']['id']}/tickets", headers=second).json()
    other_receipt = scan(client, admitted["event"]["id"], other_ticket["qr_payload"], admitted["staff"]).json()
    request_id = new_request_id()
    assert undo(client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admitted["owner"], request_id).status_code == 200

    by_someone_else = undo(client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admin, request_id)
    for_another_check_in = undo(client, admitted["event"]["id"], other_receipt["check_in_id"], admitted["owner"], request_id)
    assert (by_someone_else.status_code, detail_code(by_someone_else)) == (409, "REQUEST_ID_CONFLICT")
    assert (for_another_check_in.status_code, detail_code(for_another_check_in)) == (409, "REQUEST_ID_CONFLICT")
    assert attendance(client, admitted["event"]["id"], admitted["staff"])["checked_in"] == 1


# ------------------------------------------------------------------ after an undo
def test_the_old_scan_request_neither_admits_again_nor_reads_as_admitted(client, db, admitted):
    event_id, payload = admitted["event"]["id"], admitted["ticket"]["qr_payload"]
    undo(client, event_id, admitted["receipt"]["check_in_id"], admitted["owner"])

    replay = scan(client, event_id, payload, admitted["staff"], admitted["scan_request_id"])
    assert (replay.status_code, detail_code(replay)) == (409, "CHECK_IN_UNDONE")
    assert len(check_in_rows(db, admitted["ticket"]["id"])) == 1
    assert attendance(client, event_id, admitted["staff"])["checked_in"] == 0


def test_a_new_scan_admits_again_and_the_old_request_stays_history(client, db, admitted):
    event_id, payload = admitted["event"]["id"], admitted["ticket"]["qr_payload"]
    undo(client, event_id, admitted["receipt"]["check_in_id"], admitted["owner"])

    again = scan(client, event_id, payload, admitted["staff"])
    assert again.status_code == 200, again.text
    assert again.json()["check_in_id"] != admitted["receipt"]["check_in_id"]
    assert again.json()["ticket_id"] == admitted["ticket"]["id"]
    rows = check_in_rows(db, admitted["ticket"]["id"])
    assert [row.undone_at is None for row in rows] == [False, True]
    assert attendance(client, event_id, admitted["staff"])["checked_in"] == 1
    assert found(client, event_id, admitted["staff"])[0]["check_in_id"] == again.json()["check_in_id"]

    # The undone request must not borrow the new admission's receipt.
    old = scan(client, event_id, payload, admitted["staff"], admitted["scan_request_id"])
    assert (old.status_code, detail_code(old)) == (409, "CHECK_IN_UNDONE")
    duplicate = scan(client, event_id, payload, admitted["staff"])
    assert (duplicate.status_code, detail_code(duplicate)) == (409, "ALREADY_CHECKED_IN")
    assert len(check_in_rows(db, admitted["ticket"]["id"])) == 2


def test_the_second_admission_can_be_undone_too_but_not_through_the_first_id(client, db, admitted):
    event_id, payload = admitted["event"]["id"], admitted["ticket"]["qr_payload"]
    first_id = admitted["receipt"]["check_in_id"]
    undo(client, event_id, first_id, admitted["owner"])
    second_id = scan(client, event_id, payload, admitted["staff"]).json()["check_in_id"]

    stale = undo(client, event_id, first_id, admitted["owner"])
    assert (stale.status_code, detail_code(stale)) == (409, "CHECK_IN_ALREADY_UNDONE")
    assert attendance(client, event_id, admitted["staff"])["checked_in"] == 1
    assert undo(client, event_id, second_id, admitted["owner"]).status_code == 200
    assert [row.undone_at is None for row in check_in_rows(db, admitted["ticket"]["id"])] == [False, False]


def test_cancelling_after_an_undo_closes_the_ticket_for_old_and_new_requests(client, admitted):
    event_id, payload = admitted["event"]["id"], admitted["ticket"]["qr_payload"]
    undo(client, event_id, admitted["receipt"]["check_in_id"], admitted["owner"])
    assert client.post(f"/tickets/{admitted['ticket']['id']}/cancel", headers=admitted["attendee"]).status_code == 200

    old = scan(client, event_id, payload, admitted["staff"], admitted["scan_request_id"])
    new = scan(client, event_id, payload, admitted["staff"])
    assert (old.status_code, detail_code(old)) == (409, "CHECK_IN_UNDONE")
    assert (new.status_code, detail_code(new)) == (409, "TICKET_CANCELLED")


def test_a_foreign_replay_of_an_undone_request_is_still_a_conflict(client, admitted):
    undo(client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admitted["owner"])
    response = scan(
        client, admitted["event"]["id"], admitted["ticket"]["qr_payload"], admitted["owner"],
        admitted["scan_request_id"],
    )
    assert (response.status_code, detail_code(response)) == (409, "REQUEST_ID_CONFLICT")


def test_undo_still_works_after_the_event_is_cancelled(client, admitted):
    client.post(f"/events/{admitted['event']['id']}/cancel", headers=admitted["owner"])
    response = undo(client, admitted["event"]["id"], admitted["receipt"]["check_in_id"], admitted["owner"])
    assert response.status_code == 200, response.text


# ------------------------------------------------------------------ database rules
def test_database_allows_one_current_check_in_per_ticket_and_keeps_undone_ones(db, admitted):
    ticket_id, event_id, staff_id = admitted["ticket"]["id"], admitted["event"]["id"], admitted["staff_user"].id
    db.add(CheckIn(ticket_id=ticket_id, event_id=event_id, staff_id=staff_id, request_id=uuid.uuid4()))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

    current = db.scalar(select(CheckIn).where(CheckIn.ticket_id == ticket_id))
    current.undone_at, current.undone_by_id, current.undo_request_id = current.checked_in_at, staff_id, uuid.uuid4()
    db.add(CheckIn(ticket_id=ticket_id, event_id=event_id, staff_id=staff_id, request_id=uuid.uuid4()))
    db.commit()
    assert db.scalar(select(func.count()).select_from(CheckIn).where(CheckIn.ticket_id == ticket_id)) == 2


@pytest.mark.parametrize(
    "values",
    [
        {"status": "expired"},
        {"status": "cancelled"},  # a final state without who and when
        {"status_changed_by_id": 1},  # a change record on an active ticket
    ],
)
def test_database_rejects_inconsistent_ticket_states(db, setup, values):
    ticket = db.get(Ticket, setup["ticket"]["id"])
    for name, value in values.items():
        setattr(ticket, name, value)
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_database_rejects_a_half_recorded_undo(db, admitted):
    record = db.scalar(select(CheckIn).where(CheckIn.ticket_id == admitted["ticket"]["id"]))
    record.undone_at = record.checked_in_at
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
