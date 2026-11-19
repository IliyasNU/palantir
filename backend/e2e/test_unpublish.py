"""BE-1 on PostgreSQL: unpublishing races ticket claims, and a draft never ends up holding a seat."""
from e2e.conftest import run_concurrently
from e2e.test_concurrency import codes

DRAFT_WITH_SEATS = "SELECT count(*) FROM events WHERE id = :id AND status = 'draft' AND tickets_issued > 0"


def counters_agree(sql, event_id):
    active = sql("SELECT count(*) FROM tickets WHERE event_id = :id AND status = 'active'", id=event_id)
    pending = sql("SELECT count(*) FROM orders WHERE event_id = :id AND status = 'pending'", id=event_id)
    assert sql("SELECT tickets_issued FROM events WHERE id = :id", id=event_id) == active + pending
    assert sql("SELECT coalesce(sum(tickets_issued), 0) FROM ticket_types WHERE event_id = :id", id=event_id) == \
        active + pending
    return active


def test_unpublish_racing_parallel_claims_never_leaves_a_draft_with_tickets(api, register, published_event, sql):
    owner = register("organizer")
    attendees = [register() for _ in range(10)]
    for _ in range(3):  # a few rounds, since which side wins differs from run to run
        event_id = published_event(owner, capacity=50)["id"]
        root = f"/events/{event_id}"
        calls = [lambda client, a=attendee: client.post(f"{root}/tickets", headers=a.headers) for attendee in attendees]
        calls.insert(5, lambda client: client.post(f"{root}/unpublish", headers=owner.headers))
        results = run_concurrently(calls)
        unpublish, claims = results[5], results[:5] + results[6:]

        outcome = codes(claims)
        assert set(outcome) <= {201, "EVENT_NOT_FOUND", "EVENT_NOT_PUBLISHED"}, outcome
        issued = counters_agree(sql, event_id)
        assert issued == outcome[201]
        if unpublish.status_code == 200:
            # It won the row lock before any claim took a seat: nothing was issued, and nothing will be.
            assert (unpublish.json()["status"], issued) == ("draft", 0)
        else:
            assert unpublish.json()["detail"]["code"] == "EVENT_HAS_TICKETS"
            assert issued > 0
            assert sql("SELECT status FROM events WHERE id = :id", id=event_id) == "published"
        assert sql(DRAFT_WITH_SEATS, id=event_id) == 0


def test_edits_racing_a_cancel_never_change_a_cancelled_event(api, register, published_event, sql):
    owner = register("organizer")
    event_id = published_event(owner)["id"]
    root = f"/events/{event_id}"
    calls = [lambda client, n=number: client.patch(root, json={"title": f"Edited {n}"}, headers=owner.headers)
             for number in range(6)]
    calls.insert(3, lambda client: client.post(f"{root}/cancel", headers=owner.headers))
    results = run_concurrently(calls)
    cancel, edits = results[3], results[:3] + results[4:]
    assert cancel.status_code == 200

    outcome = codes(edits)
    assert set(outcome) <= {200, "EVENT_CANCELLED"}, outcome
    # Edits that won the lock before the cancel are recorded before it; none is recorded after it.
    cancelled_at = sql(
        "SELECT id FROM action_logs WHERE event_id = :id AND action = 'event.cancelled'", id=event_id
    )
    assert sql(
        "SELECT count(*) FROM action_logs WHERE event_id = :id AND action = 'event.updated' AND id > :after",
        id=event_id, after=cancelled_at,
    ) == 0
    assert sql(
        "SELECT count(*) FROM action_logs WHERE event_id = :id AND action = 'event.updated'", id=event_id
    ) == outcome[200]
