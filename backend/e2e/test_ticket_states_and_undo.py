"""Cancelled/refunded tickets and check-in undo against real PostgreSQL, including the races between them."""
import uuid
from collections import Counter

import httpx

from e2e.conftest import BASE_URL, run_concurrently


def code(response):
    return response.status_code if response.status_code < 400 else response.json()["detail"]["code"]


def codes(responses):
    return Counter(code(response) for response in responses)


def new_id():
    return str(uuid.uuid4())


def setup_scan(api, register, published_event):
    owner, attendee, staff = register("organizer"), register(), register()
    event = published_event(owner)
    api.post(f"/events/{event['id']}/staff", json={"email": staff.email}, headers=owner.headers)
    ticket = api.post(f"/events/{event['id']}/tickets", headers=attendee.headers).json()
    return owner, attendee, staff, event, ticket


def scan_call(event, ticket, staff, request_id=None):
    body = {"qr_payload": ticket["qr_payload"], "request_id": request_id or new_id()}
    return lambda client: client.post(f"/events/{event['id']}/check-in", json=body, headers=staff.headers)


def undo_call(event, check_in_id, actor, request_id=None):
    body = {"request_id": request_id or new_id()}
    return lambda client: client.post(
        f"/events/{event['id']}/check-ins/{check_in_id}/undo", json=body, headers=actor.headers
    )


def close_call(ticket, actor, action="cancel"):
    return lambda client: client.post(f"/tickets/{ticket['id']}/{action}", headers=actor.headers)


def current_check_ins(sql, ticket):
    return sql("SELECT count(*) FROM check_ins WHERE ticket_id = :id AND undone_at IS NULL", id=ticket["id"])


def all_check_ins(sql, ticket):
    return sql("SELECT count(*) FROM check_ins WHERE ticket_id = :id", id=ticket["id"])


def consistent_counters(api, sql, event, staff):
    """The attendance route and the event row agree with the rows they summarise."""
    body = api.get(f"/events/{event['id']}/attendance", headers=staff.headers).json()
    assert body["checked_in"] == sql(
        "SELECT count(*) FROM check_ins WHERE event_id = :id AND undone_at IS NULL", id=event["id"]
    )
    assert body["tickets_issued"] == sql(
        "SELECT count(*) FROM tickets WHERE event_id = :id AND status = 'active'", id=event["id"]
    )
    assert body["tickets_issued"] == sql("SELECT tickets_issued FROM events WHERE id = :id", id=event["id"])
    return body


def test_closed_tickets_are_rejected_and_counted_out(api, register, published_event, sql):
    owner, attendee, staff, event, cancelled = setup_scan(api, register, published_event)
    second, third = register(), register()
    refunded = api.post(f"/events/{event['id']}/tickets", headers=second.headers).json()
    valid = api.post(f"/events/{event['id']}/tickets", headers=third.headers).json()

    assert api.post(f"/tickets/{cancelled['id']}/cancel", headers=attendee.headers).json()["status"] == "cancelled"
    assert api.post(f"/tickets/{refunded['id']}/refund", headers=owner.headers).json()["status"] == "refunded"

    assert code(scan_call(event, cancelled, staff)(api)) == "TICKET_CANCELLED"
    assert code(scan_call(event, refunded, staff)(api)) == "TICKET_REFUNDED"
    assert code(scan_call(event, valid, staff)(api)) == 200
    assert all_check_ins(sql, cancelled) == all_check_ins(sql, refunded) == 0
    assert consistent_counters(api, sql, event, staff) == {
        "event_id": event["id"], "capacity": event["capacity"], "tickets_issued": 1, "checked_in": 1,
    }


def test_scan_racing_a_cancel_ends_in_exactly_one_of_two_states(api, register, published_event, sql):
    outcomes = Counter()
    for _ in range(12):  # repeat: both orders must be reachable and both must stay consistent
        owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
        scan, cancel = run_concurrently([scan_call(event, ticket, staff), close_call(ticket, attendee)])
        result = (code(scan), code(cancel))
        assert result in {(200, "TICKET_CHECKED_IN"), ("TICKET_CANCELLED", 200)}, result
        status = sql("SELECT status FROM tickets WHERE id = :id", id=ticket["id"])
        assert (status, current_check_ins(sql, ticket)) == (("active", 1) if result[0] == 200 else ("cancelled", 0))
        consistent_counters(api, sql, event, staff)
        outcomes[result] += 1
    assert sum(outcomes.values()) == 12


def test_many_scans_racing_a_refund_never_admit_a_refunded_ticket(api, register, published_event, sql):
    for _ in range(4):
        owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
        calls = [scan_call(event, ticket, staff) for _ in range(6)] + [close_call(ticket, owner, "refund")]
        responses = run_concurrently(calls)
        scans, refund = responses[:-1], responses[-1]
        if code(refund) == 200:
            assert codes(scans) == {"TICKET_REFUNDED": 6}
            assert current_check_ins(sql, ticket) == 0
        else:
            assert code(refund) == "TICKET_CHECKED_IN"
            assert codes(scans) == {200: 1, "ALREADY_CHECKED_IN": 5}
            assert current_check_ins(sql, ticket) == 1
        consistent_counters(api, sql, event, staff)


def test_parallel_retries_of_one_undo_share_one_receipt(api, register, published_event, sql):
    owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
    receipt = scan_call(event, ticket, staff)(api).json()
    request_id = new_id()
    responses = run_concurrently([undo_call(event, receipt["check_in_id"], owner, request_id) for _ in range(8)])
    assert [response.status_code for response in responses] == [200] * 8
    assert len({response.text for response in responses}) == 1
    assert (current_check_ins(sql, ticket), all_check_ins(sql, ticket)) == (0, 1)


def test_two_different_undo_requests_reverse_the_admission_once(api, register, published_event, sql):
    for _ in range(5):
        owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
        receipt = scan_call(event, ticket, staff)(api).json()
        responses = run_concurrently([undo_call(event, receipt["check_in_id"], owner) for _ in range(2)])
        assert codes(responses) == {200: 1, "CHECK_IN_ALREADY_UNDONE": 1}
        assert sql("SELECT count(*) FROM check_ins WHERE undo_request_id IS NOT NULL AND ticket_id = :id", id=ticket["id"]) == 1


def test_undo_response_lost_after_the_write_then_retry(api, register, published_event, sql):
    """The undo commits, the client never reads the answer, and the retry returns the same receipt."""
    owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
    receipt = scan_call(event, ticket, staff)(api).json()
    request_id = new_id()
    path = f"/events/{event['id']}/check-ins/{receipt['check_in_id']}/undo"
    with httpx.Client(base_url=BASE_URL, timeout=30) as lost:
        with lost.stream("POST", path, json={"request_id": request_id}, headers=owner.headers) as response:
            assert response.status_code == 200  # committed; the body is never read
    assert current_check_ins(sql, ticket) == 0

    retry = api.post(path, json={"request_id": request_id}, headers=owner.headers)
    assert retry.status_code == 200
    assert retry.json()["request_id"] == request_id
    assert (current_check_ins(sql, ticket), all_check_ins(sql, ticket)) == (0, 1)


def test_after_an_undo_parallel_new_scans_admit_once_and_the_old_request_never(api, register, published_event, sql):
    owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
    old_request = new_id()
    receipt = scan_call(event, ticket, staff, old_request)(api).json()
    assert undo_call(event, receipt["check_in_id"], owner)(api).status_code == 200

    calls = [scan_call(event, ticket, staff) for _ in range(6)]
    calls += [scan_call(event, ticket, staff, old_request) for _ in range(4)]
    responses = run_concurrently(calls)
    assert codes(responses[:6]) == {200: 1, "ALREADY_CHECKED_IN": 5}
    assert codes(responses[6:]) == {"CHECK_IN_UNDONE": 4}
    assert (current_check_ins(sql, ticket), all_check_ins(sql, ticket)) == (1, 2)
    assert sql("SELECT undone_at IS NOT NULL FROM check_ins WHERE request_id = :id", id=old_request) is True
    consistent_counters(api, sql, event, staff)


def test_undo_racing_a_new_scan_and_a_cancel_stays_consistent(api, register, published_event, sql):
    """Undo, a fresh scan and a cancel hit one admitted ticket together; every reachable end state is coherent."""
    for _ in range(10):
        owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
        receipt = scan_call(event, ticket, staff)(api).json()
        undo, scan, cancel = run_concurrently(
            [undo_call(event, receipt["check_in_id"], owner), scan_call(event, ticket, staff), close_call(ticket, attendee)]
        )
        assert code(undo) == 200  # nothing else can undo or remove this admission
        status = sql("SELECT status FROM tickets WHERE id = :id", id=ticket["id"])
        current = current_check_ins(sql, ticket)
        if code(cancel) == 200:
            # The cancel ran after the undo and before any new admission.
            assert code(scan) in {"ALREADY_CHECKED_IN", "TICKET_CANCELLED"}
            assert (status, current) == ("cancelled", 0)
        else:
            assert code(cancel) == "TICKET_CHECKED_IN"
            assert status == "active"
            assert (code(scan), current) in {(200, 1), ("ALREADY_CHECKED_IN", 0)}
        assert all_check_ins(sql, ticket) == 1 + (code(scan) == 200)
        consistent_counters(api, sql, event, staff)


def test_scan_response_lost_then_undone_then_retried(api, register, published_event, sql):
    """A lost check-in response followed by an undo: the retry must not show the historical success."""
    owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
    request_id = new_id()
    body = {"qr_payload": ticket["qr_payload"], "request_id": request_id}
    with httpx.Client(base_url=BASE_URL, timeout=30) as lost:
        with lost.stream("POST", f"/events/{event['id']}/check-in", json=body, headers=staff.headers) as response:
            assert response.status_code == 200
    check_in_id = sql("SELECT id FROM check_ins WHERE request_id = :id", id=request_id)
    assert undo_call(event, check_in_id, owner)(api).status_code == 200

    retry = api.post(f"/events/{event['id']}/check-in", json=body, headers=staff.headers)
    assert code(retry) == "CHECK_IN_UNDONE"
    assert (current_check_ins(sql, ticket), all_check_ins(sql, ticket)) == (0, 1)


def test_migrated_constraints_hold_on_postgres(api, register, published_event, db_engine, sql):
    """One current check-in per ticket, undone rows kept, and no half-recorded state."""
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    owner, attendee, staff, event, ticket = setup_scan(api, register, published_event)
    scan_call(event, ticket, staff)(api)
    insert = text(
        "INSERT INTO check_ins (ticket_id, event_id, staff_id, request_id) "
        "VALUES (:ticket, :event, :staff, gen_random_uuid())"
    )
    values = {"ticket": ticket["id"], "event": event["id"], "staff": staff.id}
    for statement, params in (
        (insert, values),
        (text("UPDATE check_ins SET undone_at = now() WHERE ticket_id = :ticket"), values),
        (text("UPDATE tickets SET status = 'expired' WHERE id = :ticket"), values),
        (text("UPDATE tickets SET status = 'refunded' WHERE id = :ticket"), values),
    ):
        with pytest.raises(IntegrityError), db_engine.begin() as connection:
            connection.execute(statement, params)
    assert (current_check_ins(sql, ticket), all_check_ins(sql, ticket)) == (1, 1)
