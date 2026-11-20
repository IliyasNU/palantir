"""Support cases over HTTP with a real PostgreSQL database: access, Unicode, and concurrent writers."""
from e2e.conftest import run_concurrently
from e2e.test_concurrency import codes
from e2e.test_suspension import admin  # noqa: F401  (fixture)

KAZAKH = "Билетім келмеді. Көмектесіңізші — Әлия Жұмабаева, қаңтар"


def open_case(api, requester, **fields):
    body = {"category": "ticket_delivery", "subject": "Ticket did not arrive", "message": KAZAKH, **fields}
    response = api.post("/support/cases", json=body, headers=requester.headers)
    assert response.status_code == 201, response.text
    return response.json()


def claim(api, event_id, attendee):
    response = api.post(f"/events/{event_id}/tickets", headers=attendee.headers)
    assert response.status_code == 201, response.text
    return response.json()


def test_case_is_private_to_its_requester_and_handlers_and_keeps_kazakh_text(
    api, register, published_event, admin, sql
):
    owner, attendee, outsider, other_owner = register("organizer"), register(), register(), register("organizer")
    event_id = published_event(owner)["id"]
    ticket = claim(api, event_id, attendee)
    case = open_case(api, attendee, ticket_id=ticket["id"])
    path = f"/support/cases/{case['id']}"
    assert (case["event_id"], case["ticket_id"], case["messages"][0]["body"]) == (event_id, ticket["id"], KAZAKH)

    for stranger in (outsider, other_owner):
        for call in (
            lambda: api.get(path, headers=stranger.headers),
            lambda: api.get(f"{path}/messages", headers=stranger.headers),
            lambda: api.post(f"{path}/messages", json={"body": "Let me in"}, headers=stranger.headers),
            lambda: api.patch(path, json={"status": "resolved"}, headers=stranger.headers),
        ):
            response = call()
            assert (response.status_code, response.json()["detail"]["code"]) == (404, "CASE_NOT_FOUND")
    assert sql("SELECT status FROM support_cases WHERE id = :id", id=case["id"]) == "open"
    assert sql("SELECT count(*) FROM support_messages WHERE case_id = :id", id=case["id"]) == 1

    for handler in (owner, admin):
        seen = api.get(path, headers=handler.headers)
        assert seen.status_code == 200 and seen.json()["can_manage"] is True
    reply = api.post(f"{path}/messages", json={"body": "Қазір тексереміз"}, headers=owner.headers)
    assert reply.status_code == 201 and reply.json()["body"] == "Қазір тексереміз"
    assert sql("SELECT body FROM support_messages WHERE id = :id", id=reply.json()["id"]) == "Қазір тексереміз"
    assert [row["id"] for row in api.get(f"/events/{event_id}/support-cases", headers=owner.headers).json()] == [
        case["id"]
    ]


def test_parallel_replies_all_land_and_the_case_points_at_the_last_one(api, register, published_event, sql):
    owner, attendee = register("organizer"), register()
    event_id = published_event(owner)["id"]
    case = open_case(api, attendee, event_id=event_id)
    path = f"/support/cases/{case['id']}/messages"

    writers = [owner, attendee] * 8
    results = run_concurrently([
        lambda client, who=writer, n=number: client.post(path, json={"body": f"reply {n}"}, headers=who.headers)
        for number, writer in enumerate(writers)
    ])
    assert codes(results) == {201: 16}
    assert len({result.json()["id"] for result in results}) == 16
    assert sql("SELECT count(*) FROM support_messages WHERE case_id = :id", id=case["id"]) == 17

    # Writers took the case row lock in turn: message time follows message id, and the case shows the newest.
    assert sql(
        "SELECT count(*) FROM support_messages a JOIN support_messages b ON b.case_id = a.case_id AND b.id > a.id "
        "WHERE a.case_id = :id AND b.created_at < a.created_at",
        id=case["id"],
    ) == 0
    assert sql(
        "SELECT c.last_message_at = m.created_at AND c.last_message_by = m.author_side AND c.updated_at = m.created_at "
        "FROM support_cases c JOIN support_messages m ON m.case_id = c.id "
        "WHERE c.id = :id ORDER BY m.id DESC LIMIT 1",
        id=case["id"],
    ) is True
    thread = api.get(path, headers=attendee.headers).json()
    assert [message["id"] for message in thread] == sorted(message["id"] for message in thread)


def test_parallel_status_changes_record_one_entry_per_real_change(api, register, published_event, admin, sql):
    owner, attendee = register("organizer"), register()
    event_id = published_event(owner)["id"]
    case = open_case(api, attendee, event_id=event_id)
    path = f"/support/cases/{case['id']}"

    def changes(description):
        return sql(
            "SELECT count(*) FROM action_logs WHERE entity_type = 'support_case' AND entity_id = :id "
            "AND action = 'support_case.status_changed' AND description = :description",
            id=case["id"], description=description,
        )

    # Six handlers' requests set the same status at once: one of them changes it, the others find it done.
    handlers = [owner, admin] * 3
    results = run_concurrently([
        lambda client, who=handler: client.patch(path, json={"status": "waiting_for_customer"}, headers=who.headers)
        for handler in handlers
    ])
    assert codes(results) == {200: 6}
    assert changes("status: open -> waiting_for_customer") == 1

    # Five replies from the requester arrive together: the case is reopened once.
    results = run_concurrently([
        lambda client, n=number: client.post(f"{path}/messages", json={"body": f"answer {n}"},
                                             headers=attendee.headers)
        for number in range(5)
    ])
    assert codes(results) == {201: 5}
    assert changes("status: waiting_for_customer -> in_progress") == 1
    assert sql("SELECT status FROM support_cases WHERE id = :id", id=case["id"]) == "in_progress"
    assert sql(
        "SELECT count(*) FROM action_logs WHERE entity_type = 'support_case' AND entity_id = :id", id=case["id"]
    ) == 3  # opened, and the two status changes


def test_organizer_case_reaches_admins_and_is_recorded_as_a_platform_action(api, register, admin, sql):
    owner, other_owner = register("organizer"), register("organizer")
    case = open_case(api, owner, kind="organizer", category="activation", subject="Activation is stuck")
    path = f"/support/cases/{case['id']}"
    assert (case["kind"], case["event_id"]) == ("organizer", None)
    assert api.get(path, headers=other_owner.headers).status_code == 404

    queue = api.get("/admin/support-cases", params={"kind": "organizer", "limit": 100}, headers=admin.headers).json()
    assert case["id"] in [row["id"] for row in queue]
    taken = api.patch(path, json={"assignee_id": admin.id, "status": "in_progress"}, headers=admin.headers)
    assert taken.status_code == 200 and taken.json()["assignee"]["id"] == admin.id
    assert sql(
        "SELECT count(*) FROM action_logs WHERE event_id IS NULL AND entity_type = 'support_case' AND entity_id = :id",
        id=case["id"],
    ) == 3  # opened, status changed, assigned
