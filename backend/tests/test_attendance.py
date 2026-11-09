"""GET /events/{id}/attendance and GET /events/{id}/attendees: totals and manual lookup for scanners."""
import uuid

import pytest

from app.schemas.attendance import mask_email

PATHS = ["/events/{id}/attendance", "/events/{id}/attendees?q=att"]


def detail_code(response):
    return response.json()["detail"]["code"]


def scan(client, event_id, qr_payload, headers, request_id=None):
    body = {"qr_payload": qr_payload, "request_id": request_id or str(uuid.uuid4())}
    return client.post(f"/events/{event_id}/check-in", json=body, headers=headers)


def attendance(client, event_id, headers):
    response = client.get(f"/events/{event_id}/attendance", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def search(client, event_id, q, headers):
    return client.get(f"/events/{event_id}/attendees", params={"q": q}, headers=headers)


@pytest.fixture()
def holder(client, create_user, auth_header):
    """Create a user with a given name and e-mail who claims a ticket for ``event_id``."""

    def _holder(event_id, email, full_name="Test User"):
        create_user(email, full_name=full_name)
        headers = auth_header(email)
        response = client.post(f"/events/{event_id}/tickets", headers=headers)
        assert response.status_code == 201, response.text
        return response.json()

    return _holder


@pytest.fixture()
def setup(client, login_as, new_event, holder):
    """A published event with assigned staff and one attendee ticket."""
    _, owner = login_as("owner@example.com", "organizer")
    staff_user, staff = login_as("staff@example.com")
    event = new_event(owner, capacity=50)
    assigned = client.post(f"/events/{event['id']}/staff", json={"email": "staff@example.com"}, headers=owner)
    assert assigned.status_code == 201, assigned.text
    ticket = holder(event["id"], "attendee@example.com", "Aigerim Attendee")
    return {"owner": owner, "staff": staff, "staff_user": staff_user, "event": event, "ticket": ticket}


# ------------------------------------------------------------------ email masking
@pytest.mark.parametrize(
    ("email", "masked"),
    [
        ("alice@example.com", "al***@example.com"),
        ("abc@x.kz", "ab***@x.kz"),
        ("ab@x.kz", "a***@x.kz"),  # two characters: never reveal the whole local part
        ("a@x.kz", "***@x.kz"),
        ("@x.kz", "***@x.kz"),
        ("not-an-email", "***"),
    ],
)
def test_mask_email_reveals_at_most_two_characters_and_never_the_whole_local_part(email, masked):
    assert mask_email(email) == masked


def test_mask_length_does_not_reveal_local_part_length():
    assert mask_email("abcdefghij@x.kz").count("*") == mask_email("abc@x.kz").count("*") == 3


# ------------------------------------------------------------------ access (both endpoints)
@pytest.mark.parametrize("path", PATHS)
def test_guest_needs_to_log_in(client, setup, path):
    assert client.get(path.format(id=setup["event"]["id"])).status_code == 401


@pytest.mark.parametrize("path", PATHS)
def test_missing_event_is_event_not_found(client, setup, path):
    response = client.get(path.format(id=999999), headers=setup["staff"])
    assert response.status_code == 404
    assert detail_code(response) == "EVENT_NOT_FOUND"


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("who", ["attendee", "other_staff", "other_organizer"])
def test_outsiders_are_forbidden(client, login_as, new_event, setup, path, who):
    if who == "attendee":
        _, headers = login_as("visitor@example.com")
    elif who == "other_staff":
        _, headers = login_as("other-staff@example.com")
        other = new_event(setup["owner"])
        assigned = client.post(
            f"/events/{other['id']}/staff", json={"email": "other-staff@example.com"}, headers=setup["owner"]
        )
        assert assigned.status_code == 201, assigned.text
    else:
        _, headers = login_as("other-owner@example.com", "organizer")
        new_event(headers)
    response = client.get(path.format(id=setup["event"]["id"]), headers=headers)
    assert response.status_code == 403
    assert response.json()["detail"] == {"code": "FORBIDDEN", "message": "You are not staff for this event"}


@pytest.mark.parametrize("path", PATHS)
def test_ticket_holder_is_forbidden(client, auth_header, setup, path):
    response = client.get(path.format(id=setup["event"]["id"]), headers=auth_header("attendee@example.com"))
    assert response.status_code == 403
    assert detail_code(response) == "FORBIDDEN"


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("who", ["staff", "owner", "admin"])
def test_staff_organizer_and_admin_are_allowed(client, login_as, setup, path, who):
    headers = login_as("admin@example.com", "admin")[1] if who == "admin" else setup[who]
    assert client.get(path.format(id=setup["event"]["id"]), headers=headers).status_code == 200


@pytest.mark.parametrize("path", PATHS)
def test_revoked_staff_lose_access(client, setup, path):
    event_id = setup["event"]["id"]
    revoked = client.delete(f"/events/{event_id}/staff/{setup['staff_user'].id}", headers=setup["owner"])
    assert revoked.status_code == 204
    response = client.get(path.format(id=event_id), headers=setup["staff"])
    assert response.status_code == 403
    assert detail_code(response) == "FORBIDDEN"


@pytest.mark.parametrize("q", [None, "", "ab"])
def test_access_is_checked_before_the_search_query(client, login_as, setup, q):
    _, visitor = login_as("visitor@example.com")
    params = {} if q is None else {"q": q}
    forbidden = client.get(f"/events/{setup['event']['id']}/attendees", params=params, headers=visitor)
    assert forbidden.status_code == 403
    assert detail_code(forbidden) == "FORBIDDEN"
    missing = client.get("/events/999999/attendees", params=params, headers=setup["staff"])
    assert missing.status_code == 404
    assert detail_code(missing) == "EVENT_NOT_FOUND"


# ------------------------------------------------------------------ attendance counters
def test_attendance_reports_capacity_tickets_and_check_ins(client, setup):
    body = attendance(client, setup["event"]["id"], setup["staff"])
    assert body == {"event_id": setup["event"]["id"], "capacity": 50, "tickets_issued": 1, "checked_in": 0}


def test_checked_in_counter_before_and_after_check_in(client, setup):
    event_id, qr = setup["event"]["id"], setup["ticket"]["qr_payload"]
    assert attendance(client, event_id, setup["staff"])["checked_in"] == 0

    request_id = str(uuid.uuid4())
    assert scan(client, event_id, qr, setup["staff"], request_id).status_code == 200
    assert attendance(client, event_id, setup["staff"])["checked_in"] == 1

    # A replayed retry and a duplicate scan do not move the counter.
    assert scan(client, event_id, qr, setup["staff"], request_id).status_code == 200
    duplicate = scan(client, event_id, qr, setup["staff"])
    assert duplicate.status_code == 409
    assert detail_code(duplicate) == "ALREADY_CHECKED_IN"
    assert attendance(client, event_id, setup["staff"]) == {
        "event_id": event_id, "capacity": 50, "tickets_issued": 1, "checked_in": 1,
    }


def test_attendance_counts_only_this_event(client, new_event, holder, setup):
    other = new_event(setup["owner"])
    other_ticket = holder(other["id"], "elsewhere@example.com")
    assert scan(client, other["id"], other_ticket["qr_payload"], setup["owner"]).status_code == 200

    holder(setup["event"]["id"], "second@example.com")
    body = attendance(client, setup["event"]["id"], setup["staff"])
    assert body["tickets_issued"] == 2
    assert body["checked_in"] == 0


# ------------------------------------------------------------------ attendee search
def test_search_result_shape_and_values(client, setup):
    response = search(client, setup["event"]["id"], "aigerim", setup["staff"])
    assert response.status_code == 200, response.text
    assert response.json() == [
        {
            "ticket_id": setup["ticket"]["id"],
            "full_name": "Aigerim Attendee",
            "masked_email": "at***@example.com",
            "checked_in_at": None,
            "qr_payload": setup["ticket"]["qr_payload"],
        }
    ]


@pytest.mark.parametrize("q", ["AIGERIM", "attendee", "ATTENDEE@EXAMPLE", "rim att", "  Aig  "])
def test_search_matches_name_or_email_case_insensitively(client, setup, q):
    results = search(client, setup["event"]["id"], q, setup["staff"]).json()
    assert [result["ticket_id"] for result in results] == [setup["ticket"]["id"]]


def test_search_returns_only_ticket_holders_of_this_event(client, create_user, new_event, holder, setup):
    other = new_event(setup["owner"])
    holder(other["id"], "aigerim.other@example.com", "Aigerim Elsewhere")
    create_user("aigerim.noticket@example.com", full_name="Aigerim Without Ticket")
    results = search(client, setup["event"]["id"], "aigerim", setup["staff"]).json()
    assert [result["ticket_id"] for result in results] == [setup["ticket"]["id"]]


def test_search_qr_payload_drives_the_existing_check_in(client, setup):
    event_id = setup["event"]["id"]
    [found] = search(client, event_id, "aigerim", setup["staff"]).json()
    receipt = scan(client, event_id, found["qr_payload"], setup["staff"])
    assert receipt.status_code == 200, receipt.text
    assert receipt.json()["ticket_id"] == found["ticket_id"]

    [after] = search(client, event_id, "aigerim", setup["staff"]).json()
    assert after["checked_in_at"] == receipt.json()["checked_in_at"]
    assert attendance(client, event_id, setup["staff"])["checked_in"] == 1


@pytest.mark.parametrize("params", [{}, {"q": ""}, {"q": "ab"}, {"q": "  ab  "}, {"q": "     "}])
def test_search_query_must_have_three_characters(client, setup, params):
    response = client.get(f"/events/{setup['event']['id']}/attendees", params=params, headers=setup["staff"])
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "QUERY_TOO_SHORT", "message": "Search query must contain at least 3 characters",
    }


@pytest.mark.parametrize("q", ["%%%", "___", "a_g", "%ig"])
def test_search_wildcards_are_literal(client, setup, q):
    response = search(client, setup["event"]["id"], q, setup["staff"])
    assert response.status_code == 200
    assert response.json() == []


def test_search_with_nul_matches_nothing(client, setup):
    response = search(client, setup["event"]["id"], "aig\x00", setup["staff"])
    assert response.status_code == 200
    assert response.json() == []


def test_search_returns_at_most_twenty_results_ordered_by_name(client, holder, setup):
    event_id = setup["event"]["id"]
    for number in range(25, 0, -1):
        holder(event_id, f"guest{number:02d}@example.com", f"Guest {number:02d}")
    results = search(client, event_id, "guest", setup["staff"]).json()
    assert len(results) == 20
    assert [result["full_name"] for result in results] == [f"Guest {number:02d}" for number in range(1, 21)]
