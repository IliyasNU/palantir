"""The joint run from BiletFlow_Mobile_Integration_Team.pdf, steps 1-7, against the live API."""
import http.client
import json
import time
import uuid
from urllib.parse import urlsplit

from e2e.conftest import BASE_URL, PASSWORD


def scan(api, event_id, qr_payload, staff, request_id=None):
    body = {"qr_payload": qr_payload, "request_id": request_id or str(uuid.uuid4())}
    return api.post(f"/events/{event_id}/check-in", json=body, headers=staff.headers)


def assign(api, event, owner, user):
    response = api.post(f"/events/{event['id']}/staff", json={"email": user.email}, headers=owner.headers)
    assert response.status_code == 201, response.text


def claim(api, event, attendee):
    response = api.post(f"/events/{event['id']}/tickets", headers=attendee.headers)
    assert response.status_code == 201, response.text
    return response.json()


def check_ins_for(sql, ticket):
    return sql("SELECT count(*) FROM check_ins WHERE ticket_id = :id", id=ticket["id"])


def send_without_reading_response(path, body, headers):
    """Send a request and return the open connection; closing it unread simulates a lost response."""
    url = urlsplit(BASE_URL)
    connection = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=10)
    connection.request("POST", path, body=json.dumps(body), headers={**headers, "Content-Type": "application/json"})
    return connection


def wait_for(condition, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return False


# ------------------------------------------------------------------ step 1: network and login
def test_step1_health_and_login(api, register):
    assert api.get("/health").json() == {"status": "ok", "database": "up"}
    staff = register()
    assert api.post("/auth/login", json={"email": staff.email, "password": PASSWORD}).status_code == 200
    assert api.post("/auth/login", json={"email": staff.email, "password": "wrong-password"}).status_code == 401


# ------------------------------------------------------------------ step 2: access
def test_step2_staff_sees_only_assigned_events(api, register, published_event):
    owner, staff = register("organizer"), register()
    assert api.get("/staff/events", headers=staff.headers).json() == []

    event = published_event(owner)
    published_event(owner)  # not assigned
    assign(api, event, owner, staff)
    assert [item["id"] for item in api.get("/staff/events", headers=staff.headers).json()] == [event["id"]]


# ------------------------------------------------------------------ step 3: real ticket
def test_step3_attendee_gets_a_ticket_that_survives_reload(api, register, published_event, sql):
    owner, attendee = register("organizer"), register()
    event = published_event(owner)
    assert event["id"] in [item["id"] for item in api.get("/events").json()]

    ticket = claim(api, event, attendee)
    reloaded = api.get(f"/tickets/{ticket['id']}", headers=attendee.headers)
    assert reloaded.status_code == 200
    assert reloaded.json() == ticket
    assert sql("SELECT qr_payload FROM tickets WHERE id = :id", id=ticket["id"]) == ticket["qr_payload"]


# ------------------------------------------------------------------ steps 4 + 5: first scan, repeats
def test_steps4_5_first_scan_writes_one_row_and_repeats_do_not(api, register, published_event, sql):
    owner, staff, attendee = register("organizer"), register(), register()
    event = published_event(owner)
    assign(api, event, owner, staff)
    ticket = claim(api, event, attendee)
    request_id = str(uuid.uuid4())

    first = scan(api, event["id"], ticket["qr_payload"], staff, request_id)
    assert first.status_code == 200, first.text
    assert first.json()["status"] == "CHECKED_IN"
    assert first.json()["request_id"] == request_id
    assert check_ins_for(sql, ticket) == 1

    # The same QR held in front of the camera resends the same request: same receipt, no new row.
    assert scan(api, event["id"], ticket["qr_payload"], staff, request_id).json() == first.json()
    # "Scan next" and scanning the same ticket again is a new request.
    again = scan(api, event["id"], ticket["qr_payload"], staff)
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "ALREADY_CHECKED_IN"
    assert check_ins_for(sql, ticket) == 1


# ------------------------------------------------------------------ step 6: wrong ticket, access, cancel
def test_step6_wrong_event_revoked_staff_and_cancelled_event(api, register, published_event, sql):
    owner, staff, attendee = register("organizer"), register(), register()
    event, other_event = published_event(owner), published_event(owner)
    assign(api, event, owner, staff)
    foreign_ticket = claim(api, other_event, attendee)
    ticket = claim(api, event, attendee)

    response = scan(api, event["id"], foreign_ticket["qr_payload"], staff)
    assert (response.status_code, response.json()["detail"]["code"]) == (404, "INVALID_TICKET")

    api.delete(f"/events/{event['id']}/staff/{staff.id}", headers=owner.headers)
    response = scan(api, event["id"], ticket["qr_payload"], staff)
    assert response.status_code == 403
    assert api.get("/auth/me", headers=staff.headers).status_code == 200  # 403 does not end the session

    assign(api, event, owner, staff)
    api.post(f"/events/{event['id']}/cancel", headers=owner.headers)
    response = scan(api, event["id"], ticket["qr_payload"], staff)
    assert (response.status_code, response.json()["detail"]["code"]) == (409, "EVENT_CANCELLED")
    assert check_ins_for(sql, ticket) == 0


# ------------------------------------------------------------------ step 7 + mandatory scenario: lost response
def test_mandatory_response_lost_after_write_then_retry(api, register, published_event, sql):
    owner, staff, attendee = register("organizer"), register(), register()
    event = published_event(owner)
    assign(api, event, owner, staff)
    ticket = claim(api, event, attendee)
    body = {"qr_payload": ticket["qr_payload"], "request_id": str(uuid.uuid4())}

    connection = send_without_reading_response(f"/events/{event['id']}/check-in", body, staff.headers)
    assert wait_for(lambda: check_ins_for(sql, ticket) == 1), "check-in was never written"
    connection.close()  # the phone never sees this response

    retry = api.post(f"/events/{event['id']}/check-in", json=body, headers=staff.headers)
    assert retry.status_code == 200, retry.text
    assert retry.json()["request_id"] == body["request_id"]
    assert retry.json()["ticket_id"] == ticket["id"]
    assert check_ins_for(sql, ticket) == 1


def test_connection_dropped_right_after_sending_still_ends_in_one_admission(api, register, published_event, sql):
    owner, staff, attendee = register("organizer"), register(), register()
    event = published_event(owner)
    assign(api, event, owner, staff)
    ticket = claim(api, event, attendee)
    body = {"qr_payload": ticket["qr_payload"], "request_id": str(uuid.uuid4())}

    send_without_reading_response(f"/events/{event['id']}/check-in", body, staff.headers).close()
    time.sleep(0.5)  # outcome unknown to the client: written or not

    retry = api.post(f"/events/{event['id']}/check-in", json=body, headers=staff.headers)
    assert retry.status_code == 200, retry.text
    assert check_ins_for(sql, ticket) == 1


def test_403_after_a_lost_response_leaves_the_written_entry(api, register, published_event, sql):
    owner, staff, attendee = register("organizer"), register(), register()
    event = published_event(owner)
    assign(api, event, owner, staff)
    ticket = claim(api, event, attendee)
    body = {"qr_payload": ticket["qr_payload"], "request_id": str(uuid.uuid4())}

    connection = send_without_reading_response(f"/events/{event['id']}/check-in", body, staff.headers)
    assert wait_for(lambda: check_ins_for(sql, ticket) == 1)
    connection.close()
    api.delete(f"/events/{event['id']}/staff/{staff.id}", headers=owner.headers)

    retry = api.post(f"/events/{event['id']}/check-in", json=body, headers=staff.headers)
    assert retry.status_code == 403
    # The organizer can still see the admission on the server.
    assert api.get(f"/tickets/{ticket['id']}", headers=attendee.headers).json()["checked_in_at"] is not None
    assert check_ins_for(sql, ticket) == 1
