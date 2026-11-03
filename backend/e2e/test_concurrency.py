"""PDF step 8 and related races, with real parallel requests against PostgreSQL."""
import uuid
from collections import Counter

from e2e.conftest import run_concurrently


def codes(responses):
    return Counter(
        response.status_code if response.status_code < 400 else response.json()["detail"]["code"]
        for response in responses
    )


def setup_scan(api, register, published_event, staff_count=1):
    owner, attendee = register("organizer"), register()
    event = published_event(owner)
    staff = [register() for _ in range(staff_count)]
    for member in staff:
        api.post(f"/events/{event['id']}/staff", json={"email": member.email}, headers=owner.headers)
    ticket = api.post(f"/events/{event['id']}/tickets", headers=attendee.headers).json()
    return event, ticket, staff


def check_in_call(event, ticket, staff, request_id):
    body = {"qr_payload": ticket["qr_payload"], "request_id": request_id}
    return lambda client: client.post(f"/events/{event['id']}/check-in", json=body, headers=staff.headers)


def test_two_phones_scan_one_ticket_one_entry(api, register, published_event, sql):
    for _ in range(5):  # repeat: a single lucky interleaving proves little
        event, ticket, (phone_a, phone_b) = setup_scan(api, register, published_event, staff_count=2)
        responses = run_concurrently(
            [
                check_in_call(event, ticket, phone_a, str(uuid.uuid4())),
                check_in_call(event, ticket, phone_b, str(uuid.uuid4())),
            ]
        )
        assert codes(responses) == {200: 1, "ALREADY_CHECKED_IN": 1}
        assert sql("SELECT count(*) FROM check_ins WHERE ticket_id = :id", id=ticket["id"]) == 1


def test_many_parallel_scans_of_one_ticket_admit_once(api, register, published_event, sql):
    event, ticket, staff = setup_scan(api, register, published_event, staff_count=4)
    calls = [check_in_call(event, ticket, staff[index % 4], str(uuid.uuid4())) for index in range(12)]
    assert codes(run_concurrently(calls)) == {200: 1, "ALREADY_CHECKED_IN": 11}
    assert sql("SELECT count(*) FROM check_ins WHERE ticket_id = :id", id=ticket["id"]) == 1


def test_parallel_retries_of_one_request_share_one_receipt(api, register, published_event, sql):
    event, ticket, (staff,) = setup_scan(api, register, published_event)
    request_id = str(uuid.uuid4())
    responses = run_concurrently([check_in_call(event, ticket, staff, request_id) for _ in range(8)])
    assert [response.status_code for response in responses] == [200] * 8
    assert len({response.text for response in responses}) == 1
    assert sql("SELECT count(*) FROM check_ins WHERE request_id = :id", id=request_id) == 1


def test_last_seat_goes_to_exactly_one_of_many(api, register, published_event, sql):
    owner = register("organizer")
    event = published_event(owner, capacity=1)
    attendees = [register() for _ in range(10)]
    responses = run_concurrently(
        [
            lambda client, a=attendee: client.post(f"/events/{event['id']}/tickets", headers=a.headers)
            for attendee in attendees
        ]
    )
    assert codes(responses) == {201: 1, "SOLD_OUT": 9}
    assert sql("SELECT count(*) FROM tickets WHERE event_id = :id", id=event["id"]) == 1
    assert sql("SELECT tickets_issued FROM events WHERE id = :id", id=event["id"]) == 1


def test_capacity_is_never_exceeded_under_load(api, register, published_event, sql):
    owner = register("organizer")
    event = published_event(owner, capacity=5)
    attendees = [register() for _ in range(20)]
    responses = run_concurrently(
        [
            lambda client, a=attendee: client.post(f"/events/{event['id']}/tickets", headers=a.headers)
            for attendee in attendees
        ]
    )
    assert codes(responses) == {201: 5, "SOLD_OUT": 15}
    assert sql("SELECT count(*) FROM tickets WHERE event_id = :id", id=event["id"]) == 5
    assert sql("SELECT tickets_issued FROM events WHERE id = :id", id=event["id"]) == 5


def test_double_click_claim_gives_one_ticket(api, register, published_event, sql):
    owner, attendee = register("organizer"), register()
    event = published_event(owner)
    responses = run_concurrently(
        [lambda client: client.post(f"/events/{event['id']}/tickets", headers=attendee.headers)] * 8
    )
    assert codes(responses)[201] == 1
    assert {response.json()["id"] for response in responses} == {responses[0].json()["id"]}
    assert sql("SELECT count(*) FROM tickets WHERE event_id = :id", id=event["id"]) == 1
    assert sql("SELECT tickets_issued FROM events WHERE id = :id", id=event["id"]) == 1


def test_cancel_always_wins_against_a_parallel_publish(api, register, sql):
    owner = register("organizer")
    for _ in range(10):
        event = api.post(
            "/events",
            json={"title": "Race event", "date": "2030-06-01T12:00:00Z", "location": "Hall", "capacity": 5},
            headers=owner.headers,
        ).json()
        run_concurrently(
            [
                lambda client: client.post(f"/events/{event['id']}/publish", headers=owner.headers),
                lambda client: client.post(f"/events/{event['id']}/cancel", headers=owner.headers),
            ]
        )
        assert sql("SELECT status FROM events WHERE id = :id", id=event["id"]) == "cancelled"
