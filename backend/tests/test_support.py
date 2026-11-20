"""Support cases (SRS 4.13): context, access, the message thread, statuses, assignment and history."""
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.models import ActionLog
from app.models.support import SupportCase, SupportMessage

SECRET_TEXT = "My phone is +7 701 000 00 00"


def detail_code(response):
    return response.json()["detail"]["code"]


@pytest.fixture()
def world(client, login_as, new_event):
    """A published event with check-in staff, a ticket holder and people who have nothing to do with it."""
    admin_user, admin = login_as("admin@example.com", "admin")
    owner_user, owner = login_as("owner@example.com", "organizer")
    other_owner_user, other_owner = login_as("other-owner@example.com", "organizer")
    staff_user, staff = login_as("staff@example.com")
    alice_user, alice = login_as("alice@example.com")
    bob_user, bob = login_as("bob@example.com")
    event = new_event(owner, capacity=10)
    assigned = client.post(f"/events/{event['id']}/staff", json={"email": "staff@example.com"}, headers=owner)
    assert assigned.status_code == 201, assigned.text
    ticket = client.post(f"/events/{event['id']}/tickets", headers=alice).json()
    return SimpleNamespace(
        admin=admin, admin_user=admin_user, owner=owner, owner_user=owner_user,
        other_owner=other_owner, other_owner_user=other_owner_user, staff=staff, staff_user=staff_user,
        alice=alice, alice_user=alice_user, bob=bob, bob_user=bob_user, event=event, ticket=ticket,
    )


def open_case(client, headers, **fields):
    body = {"category": "ticket_delivery", "subject": "Ticket did not arrive", "message": SECRET_TEXT}
    body.update(fields)
    return client.post("/support/cases", json=body, headers=headers)


@pytest.fixture()
def case(client, world):
    """Alice's case about her ticket."""
    response = open_case(client, world.alice, ticket_id=world.ticket["id"])
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture()
def platform_case(client, world):
    """The organizer's request to platform support."""
    response = open_case(client, world.owner, kind="organizer", category="activation", subject="Activation is stuck")
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture()
def paid_order(client, world):
    """Bob's order for a paid type of the event: pending, or paid with its ticket."""
    event_id = world.event["id"]
    default = world.event["ticket_types"][0]["id"]
    assert client.patch(f"/events/{event_id}/ticket-types/{default}", json={"quantity": 5},
                        headers=world.owner).status_code == 200
    paid_type = client.post(f"/events/{event_id}/ticket-types", headers=world.owner,
                            json={"name": "Paid", "price_tiyn": 10050, "quantity": 2}).json()["id"]
    assert client.post("/organizer-profiles", headers=world.owner, json={"organization_name": "Demo"}).status_code == 201
    for route, body in (("/organizer-profiles/me/confirm-identity", None),
                        ("/organizer-profiles/me/payout-details", {"reference_last4": "D123"}),
                        (f"/events/{event_id}/activation/terms", None), (f"/events/{event_id}/activation/fee", None)):
        result = client.post(route, headers=world.owner, json=body)
        assert result.status_code == 200, result.text

    def _order(pay: bool) -> dict:
        created = client.post(f"/events/{event_id}/orders", headers=world.bob, json={
            "ticket_type_id": paid_type, "attendee_name": "Bob Test", "attendee_email": "bob@example.com",
            "request_id": str(uuid4()),
        })
        assert created.status_code == 201, created.text
        if not pay:
            return created.json()
        paid = client.post(f"/orders/{created.json()['id']}/pay", headers=world.bob, json={"outcome": "success"})
        assert paid.status_code == 200, paid.text
        return paid.json()

    return _order


def support_log(client, world, **params):
    """Support entries of the event's timeline, oldest first."""
    params.setdefault("action", "support_case")
    response = client.get(f"/events/{world.event['id']}/action-log", params=params, headers=world.owner)
    assert response.status_code == 200, response.text
    return list(reversed(response.json()))


# ------------------------------------------------------------------ opening a case
def test_attendee_opens_a_case_about_their_ticket(client, world, case):
    assert set(case) == {
        "id", "kind", "category", "subject", "status", "requester", "assignee", "event_id", "event_title",
        "order_id", "ticket_id", "created_at", "updated_at", "last_message_at", "last_message_by",
        "viewer_side", "can_manage", "context", "messages",
    }
    assert (case["kind"], case["status"], case["category"]) == ("attendee", "open", "ticket_delivery")
    assert case["requester"] == {
        "id": world.alice_user.id, "full_name": world.alice_user.full_name, "masked_email": "al***@example.com",
    }
    assert case["assignee"] is None
    # The event comes from the ticket; a free ticket has no order.
    assert (case["event_id"], case["ticket_id"], case["order_id"]) == (world.event["id"], world.ticket["id"], None)
    assert case["event_title"] == world.event["title"]
    assert case["context"] == {
        "event": {"id": world.event["id"], "title": world.event["title"], "status": "published"},
        "order": None,
        "ticket": {"id": world.ticket["id"], "status": "active"},
    }
    assert (case["viewer_side"], case["can_manage"], case["last_message_by"]) == ("requester", False, "requester")
    [message] = case["messages"]
    assert set(message) == {"id", "case_id", "author_id", "author_name", "author_side", "body", "created_at"}
    assert (message["author_id"], message["author_side"], message["body"]) == (
        world.alice_user.id, "requester", SECRET_TEXT,
    )


def test_case_can_be_opened_from_an_event_page_without_a_ticket(client, world):
    response = open_case(client, world.bob, category="event_information", event_id=world.event["id"])
    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["event_id"], body["ticket_id"], body["order_id"]) == (world.event["id"], None, None)
    assert body["context"]["ticket"] is None and body["context"]["order"] is None


def test_order_and_ticket_complete_each_other(client, world, paid_order):
    pending = paid_order(pay=False)
    from_pending = open_case(client, world.bob, category="payment", order_id=pending["id"]).json()
    assert (from_pending["order_id"], from_pending["ticket_id"], from_pending["event_id"]) == (
        pending["id"], None, world.event["id"],
    )
    assert from_pending["context"]["order"] == {"id": pending["id"], "status": "pending", "total_tiyn": 10050}

    assert client.post(f"/orders/{pending['id']}/pay", headers=world.bob, json={"outcome": "success"}).status_code == 200
    paid = client.get(f"/orders/{pending['id']}", headers=world.bob).json()
    from_order = open_case(client, world.bob, category="refund", order_id=paid["id"]).json()
    assert (from_order["order_id"], from_order["ticket_id"]) == (paid["id"], paid["ticket_id"])
    from_ticket = open_case(client, world.bob, category="refund", ticket_id=paid["ticket_id"]).json()
    assert (from_ticket["order_id"], from_ticket["ticket_id"]) == (paid["id"], paid["ticket_id"])
    assert from_ticket["context"]["order"]["status"] == "paid"
    # Sending all three ids that belong together is fine too.
    everything = open_case(client, world.bob, category="refund", order_id=paid["id"], ticket_id=paid["ticket_id"],
                           event_id=world.event["id"])
    assert everything.status_code == 201, everything.text


def test_context_must_exist_belong_to_the_requester_and_agree(client, world, new_event, paid_order):
    other_event = new_event(world.owner)
    draft = new_event(world.other_owner, publish=False)
    alice_other_ticket = client.post(f"/events/{other_event['id']}/tickets", headers=world.alice).json()
    bob_pending = paid_order(pay=False)

    def refused(headers, **fields):
        response = open_case(client, headers, **fields)
        return response.status_code, detail_code(response)

    assert refused(world.alice) == (422, "CONTEXT_REQUIRED")
    assert refused(world.bob, ticket_id=world.ticket["id"]) == (404, "TICKET_NOT_FOUND")       # Alice's ticket
    assert refused(world.alice, ticket_id=999999) == (404, "TICKET_NOT_FOUND")
    assert refused(world.alice, order_id=bob_pending["id"]) == (404, "ORDER_NOT_FOUND")        # Bob's order
    assert refused(world.alice, order_id=999999) == (404, "ORDER_NOT_FOUND")
    assert refused(world.alice, event_id=999999) == (404, "EVENT_NOT_FOUND")
    assert refused(world.alice, event_id=draft["id"]) == (404, "EVENT_NOT_FOUND")              # someone's draft
    assert refused(world.alice, ticket_id=world.ticket["id"], event_id=other_event["id"]) == (422, "CONTEXT_MISMATCH")
    assert refused(world.alice, ticket_id=alice_other_ticket["id"], event_id=world.event["id"]) == (
        422, "CONTEXT_MISMATCH",
    )
    # Bob's pending order has no ticket, so it cannot belong with a ticket he holds elsewhere.
    bob_other_ticket = client.post(f"/events/{other_event['id']}/tickets", headers=world.bob).json()
    assert refused(world.bob, order_id=bob_pending["id"], ticket_id=bob_other_ticket["id"]) == (422, "CONTEXT_MISMATCH")
    assert client.get("/support/cases/mine", headers=world.alice).json() == []


def test_ticket_holder_of_a_suspended_event_can_still_ask_for_help(client, world):
    suspended = client.post(f"/admin/events/{world.event['id']}/suspend", json={"reason": "Under review"},
                            headers=world.admin)
    assert suspended.status_code == 200
    assert open_case(client, world.alice, ticket_id=world.ticket["id"]).status_code == 201
    hidden = open_case(client, world.bob, event_id=world.event["id"])
    assert (hidden.status_code, detail_code(hidden)) == (404, "EVENT_NOT_FOUND")


def test_organizer_opens_a_platform_support_case(client, world, platform_case):
    assert (platform_case["kind"], platform_case["event_id"], platform_case["context"]["event"]) == (
        "organizer", None, None,
    )
    about_event = open_case(client, world.owner, kind="organizer", category="payment", event_id=world.event["id"])
    assert about_event.status_code == 201 and about_event.json()["event_id"] == world.event["id"]

    def refused(headers, **fields):
        response = open_case(client, headers, kind="organizer", **{"category": "technical", **fields})
        return response.status_code, detail_code(response)

    assert refused(world.alice) == (403, "FORBIDDEN")                                        # not an organizer
    assert refused(world.other_owner, event_id=world.event["id"]) == (404, "EVENT_NOT_FOUND")  # not their event
    assert refused(world.owner, event_id=999999) == (404, "EVENT_NOT_FOUND")
    assert refused(world.owner, ticket_id=world.ticket["id"]) == (422, "CONTEXT_MISMATCH")


@pytest.mark.parametrize(("kind", "category"), [("attendee", "activation"), ("organizer", "seating"),
                                                ("organizer", "ticket_delivery")])
def test_category_must_fit_the_kind_of_case(client, world, kind, category):
    headers = world.owner if kind == "organizer" else world.alice
    response = open_case(client, headers, kind=kind, category=category, event_id=world.event["id"])
    assert (response.status_code, detail_code(response)) == (422, "CATEGORY_NOT_ALLOWED")


@pytest.mark.parametrize("fields", [
    {"subject": "ab"}, {"subject": "x" * 201}, {"message": "   "}, {"message": "x" * 4001},
    {"category": "other"}, {"kind": "admin"}, {"extra": 1}, {"ticket_id": "1"}, {"event_id": 0},
])
def test_invalid_case_input_is_422(client, db, world, fields):
    response = open_case(client, world.alice, **{"ticket_id": world.ticket["id"], **fields})
    assert response.status_code == 422
    assert db.scalar(select(func.count()).select_from(SupportCase)) == 0


def test_guest_cannot_use_support(client, case):
    assert open_case(client, None, event_id=1).status_code == 401
    assert client.get("/support/cases/mine").status_code == 401
    assert client.get(f"/support/cases/{case['id']}").status_code == 401


# ------------------------------------------------------------------ who sees a case
CASE_ROUTES = [
    ("get", "/support/cases/{id}", None),
    ("get", "/support/cases/{id}/messages", None),
    ("post", "/support/cases/{id}/messages", {"body": "Let me in"}),
    ("patch", "/support/cases/{id}", {"status": "resolved"}),
]


@pytest.mark.parametrize(("method", "path", "body"), CASE_ROUTES)
@pytest.mark.parametrize("outsider", ["bob", "staff", "other_owner"])
def test_outsiders_get_404_on_someone_elses_case(client, db, world, case, method, path, body, outsider):
    """Another attendee, the event's check-in staff and another organizer learn nothing about the case."""
    response = client.request(method.upper(), path.format(id=case["id"]), json=body, headers=getattr(world, outsider))
    assert (response.status_code, detail_code(response)) == (404, "CASE_NOT_FOUND")
    db.expire_all()
    assert db.get(SupportCase, case["id"]).status == "open"
    assert db.scalar(select(func.count()).select_from(SupportMessage)) == 1


@pytest.mark.parametrize(("method", "path", "body"), CASE_ROUTES)
@pytest.mark.parametrize("outsider", ["alice", "other_owner"])
def test_platform_case_is_between_its_organizer_and_admins(client, world, platform_case, method, path, body, outsider):
    response = client.request(method.upper(), path.format(id=platform_case["id"]), json=body,
                              headers=getattr(world, outsider))
    assert (response.status_code, detail_code(response)) == (404, "CASE_NOT_FOUND")


def test_unknown_case_is_404(client, world):
    response = client.get("/support/cases/999999", headers=world.admin)
    assert (response.status_code, detail_code(response)) == (404, "CASE_NOT_FOUND")


def test_requester_and_handlers_read_the_case(client, world, case, platform_case):
    def sides(case_id, headers):
        body = client.get(f"/support/cases/{case_id}", headers=headers)
        assert body.status_code == 200, body.text
        return body.json()["viewer_side"], body.json()["can_manage"]

    assert sides(case["id"], world.alice) == ("requester", False)
    assert sides(case["id"], world.owner) == ("staff", True)
    assert sides(case["id"], world.admin) == ("staff", True)
    assert sides(platform_case["id"], world.owner) == ("requester", False)   # an organizer does not handle their own
    assert sides(platform_case["id"], world.admin) == ("staff", True)


def test_organizer_who_opens_a_case_at_their_own_event_speaks_as_its_requester(client, world):
    own = open_case(client, world.owner, category="technical", event_id=world.event["id"]).json()
    assert (own["viewer_side"], own["can_manage"]) == ("requester", True)
    reply = client.post(f"/support/cases/{own['id']}/messages", json={"body": "More detail"}, headers=world.owner)
    assert reply.json()["author_side"] == "requester"


# ------------------------------------------------------------------ lists
def test_my_cases_lists_only_mine_with_latest_activity_first(client, world, case):
    second = open_case(client, world.alice, category="check_in", event_id=world.event["id"]).json()
    open_case(client, world.bob, event_id=world.event["id"])

    mine = client.get("/support/cases/mine", headers=world.alice).json()
    assert [row["id"] for row in mine] == [second["id"], case["id"]]
    assert "messages" not in mine[0] and "context" not in mine[0]

    # A reply moves the older case to the top and shows who wrote last.
    client.post(f"/support/cases/{case['id']}/messages", json={"body": "We are checking"}, headers=world.owner)
    mine = client.get("/support/cases/mine", headers=world.alice).json()
    assert [(row["id"], row["last_message_by"]) for row in mine] == [(case["id"], "staff"), (second["id"], "requester")]

    client.patch(f"/support/cases/{second['id']}", json={"status": "resolved"}, headers=world.alice)
    resolved = client.get("/support/cases/mine", params={"status": "resolved"}, headers=world.alice).json()
    assert [row["id"] for row in resolved] == [second["id"]]
    assert len(client.get("/support/cases/mine", params={"limit": 1}, headers=world.alice).json()) == 1
    assert client.get("/support/cases/mine", params={"limit": 1, "offset": 2}, headers=world.alice).json() == []
    for bad in ({"status": "closed"}, {"limit": 0}, {"limit": 101}, {"offset": -1}):
        assert client.get("/support/cases/mine", params=bad, headers=world.alice).status_code == 422


def test_event_list_shows_attendee_cases_to_its_organizer_and_admins_only(client, world, new_event, case):
    other_event = new_event(world.owner)
    elsewhere = open_case(client, world.bob, event_id=other_event["id"]).json()
    open_case(client, world.owner, kind="organizer", category="payment", event_id=world.event["id"])
    path = f"/events/{world.event['id']}/support-cases"

    for headers in (world.owner, world.admin):
        rows = client.get(path, headers=headers)
        assert rows.status_code == 200, rows.text
        assert [row["id"] for row in rows.json()] == [case["id"]]   # not the other event's, not the platform case
    for headers in (world.alice, world.staff, world.other_owner):
        refused = client.get(path, headers=headers)
        assert (refused.status_code, detail_code(refused)) == (403, "FORBIDDEN")
    assert client.get(path).status_code == 401
    missing = client.get("/events/999999/support-cases", headers=world.admin)
    assert (missing.status_code, detail_code(missing)) == (404, "EVENT_NOT_FOUND")

    client.patch(f"/support/cases/{case['id']}", json={"status": "in_progress"}, headers=world.owner)
    assert client.get(path, params={"status": "open"}, headers=world.owner).json() == []
    assert [row["id"] for row in client.get(path, params={"status": "in_progress"}, headers=world.owner).json()] == [
        case["id"]
    ]
    assert [row["id"] for row in client.get(f"/events/{other_event['id']}/support-cases",
                                            headers=world.owner).json()] == [elsewhere["id"]]


def test_admin_list_covers_every_case(client, world, case, platform_case):
    def ids(**params):
        response = client.get("/admin/support-cases", params=params, headers=world.admin)
        assert response.status_code == 200, response.text
        return [row["id"] for row in response.json()]

    assert ids() == [platform_case["id"], case["id"]]
    assert ids(kind="organizer") == [platform_case["id"]]
    assert ids(kind="attendee") == [case["id"]]
    assert ids(status="resolved") == []
    assert ids(kind="attendee", limit=1, offset=1) == []
    for headers in (world.owner, world.alice):
        assert client.get("/admin/support-cases", headers=headers).status_code == 403
    assert client.get("/admin/support-cases").status_code == 401


# ------------------------------------------------------------------ the thread
def test_thread_is_read_by_polling_for_newer_messages(client, world, case):
    path = f"/support/cases/{case['id']}/messages"
    first_id = case["messages"][0]["id"]
    assert client.get(path, params={"after_id": first_id}, headers=world.alice).json() == []

    reply = client.post(path, json={"body": "  We are checking your ticket  "}, headers=world.owner)
    assert reply.status_code == 201, reply.text
    assert (reply.json()["author_side"], reply.json()["author_name"], reply.json()["body"]) == (
        "staff", world.owner_user.full_name, "We are checking your ticket",
    )
    from_admin = client.post(path, json={"body": "Platform support here"}, headers=world.admin).json()
    assert from_admin["author_side"] == "staff"
    back = client.post(path, json={"body": "Thank you"}, headers=world.alice).json()

    new = client.get(path, params={"after_id": first_id}, headers=world.alice).json()
    assert [message["id"] for message in new] == [reply.json()["id"], from_admin["id"], back["id"]]
    assert [message["author_side"] for message in new] == ["staff", "staff", "requester"]
    assert client.get(path, params={"after_id": back["id"]}, headers=world.owner).json() == []
    whole = client.get(f"/support/cases/{case['id']}", headers=world.owner).json()
    assert [message["id"] for message in whole["messages"]] == [first_id] + [message["id"] for message in new]
    assert (whole["last_message_by"], whole["last_message_at"]) == ("requester", back["created_at"])
    assert whole["updated_at"] == back["created_at"]
    assert client.get(path, params={"after_id": -1}, headers=world.alice).status_code == 422


@pytest.mark.parametrize("body", [None, {}, {"body": ""}, {"body": "  "}, {"body": "x" * 4001}, {"body": "ok", "x": 1}])
def test_invalid_message_is_422(client, db, world, case, body):
    response = client.post(f"/support/cases/{case['id']}/messages", json=body, headers=world.alice)
    assert response.status_code == 422
    assert db.scalar(select(func.count()).select_from(SupportMessage)) == 1


def test_messages_are_never_edited_or_deleted(client, world, case):
    path = f"/support/cases/{case['id']}/messages"
    for method in ("PUT", "PATCH", "DELETE"):
        assert client.request(method, path, json={}, headers=world.admin).status_code == 405
        assert client.request(method, f"{path}/{case['messages'][0]['id']}", json={}, headers=world.admin).status_code in (404, 405)
    assert client.delete(f"/support/cases/{case['id']}", headers=world.admin).status_code == 405


# ------------------------------------------------------------------ status and assignment
def test_handlers_move_a_case_through_its_statuses(client, world, case):
    path = f"/support/cases/{case['id']}"
    for new_status in ("in_progress", "waiting_for_customer", "resolved", "open"):
        response = client.patch(path, json={"status": new_status}, headers=world.owner)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == new_status
    assert client.patch(path, json={"status": "in_progress"}, headers=world.admin).json()["status"] == "in_progress"
    assert [entry["description"] for entry in support_log(client, world, action="support_case.status_changed")] == [
        "status: open -> in_progress", "status: in_progress -> waiting_for_customer",
        "status: waiting_for_customer -> resolved", "status: resolved -> open", "status: open -> in_progress",
    ]


def test_repeating_a_change_or_sending_nothing_is_a_no_op(client, world, case):
    path = f"/support/cases/{case['id']}"
    first = client.patch(path, json={"status": "in_progress", "assignee_id": world.owner_user.id}, headers=world.owner)
    again = client.patch(path, json={"status": "in_progress", "assignee_id": world.owner_user.id}, headers=world.owner)
    empty = client.patch(path, json={}, headers=world.owner)
    assert first.status_code == again.status_code == empty.status_code == 200
    assert again.json()["updated_at"] == empty.json()["updated_at"] == first.json()["updated_at"]
    assert [entry["action"] for entry in support_log(client, world)] == [
        "support_case.opened", "support_case.status_changed", "support_case.assigned",
    ]


def test_requester_may_only_mark_their_case_resolved(client, db, world, case):
    path = f"/support/cases/{case['id']}"
    for body in ({"status": "in_progress"}, {"status": "waiting_for_customer"}, {"assignee_id": world.owner_user.id},
                 {"assignee_id": None}, {"status": "resolved", "assignee_id": world.owner_user.id}):
        refused = client.patch(path, json=body, headers=world.alice)
        assert (refused.status_code, detail_code(refused)) == (403, "FORBIDDEN"), body
    db.expire_all()
    assert (db.get(SupportCase, case["id"]).status, db.get(SupportCase, case["id"]).assignee_id) == ("open", None)

    assert client.patch(path, json={}, headers=world.alice).status_code == 200
    closed = client.patch(path, json={"status": "resolved"}, headers=world.alice)
    assert closed.status_code == 200 and closed.json()["status"] == "resolved"
    [entry] = support_log(client, world, action="support_case.status_changed")
    assert (entry["actor_id"], entry["description"]) == (world.alice_user.id, "status: open -> resolved")
    assert client.patch(path, json={"status": None}, headers=world.owner).status_code == 422
    assert client.patch(path, json={"status": "closed"}, headers=world.owner).status_code == 422


@pytest.mark.parametrize(("waiting", "after_reply"), [("waiting_for_customer", "in_progress"), ("resolved", "open")])
def test_reply_from_the_requester_reopens_the_case(client, world, case, waiting, after_reply):
    path = f"/support/cases/{case['id']}"
    client.patch(path, json={"status": waiting}, headers=world.owner)
    # A reply from staff leaves the status alone.
    client.post(f"{path}/messages", json={"body": "Any news?"}, headers=world.owner)
    assert client.get(path, headers=world.owner).json()["status"] == waiting

    client.post(f"{path}/messages", json={"body": "Here is what you asked for"}, headers=world.alice)
    assert client.get(path, headers=world.owner).json()["status"] == after_reply
    last = support_log(client, world, action="support_case.status_changed")[-1]
    assert (last["actor_id"], last["description"]) == (world.alice_user.id, f"status: {waiting} -> {after_reply}")
    # In any other status a reply changes nothing.
    client.post(f"{path}/messages", json={"body": "One more thing"}, headers=world.alice)
    assert client.get(path, headers=world.owner).json()["status"] == after_reply
    assert len(support_log(client, world, action="support_case.status_changed")) == 2


def test_case_is_assigned_only_to_someone_who_handles_it(client, world, case, create_user):
    path = f"/support/cases/{case['id']}"
    assigned = client.patch(path, json={"assignee_id": world.owner_user.id}, headers=world.owner).json()
    assert assigned["assignee"] == {"id": world.owner_user.id, "full_name": world.owner_user.full_name}
    assert client.patch(path, json={"assignee_id": world.admin_user.id}, headers=world.admin).json()["assignee"]["id"] == (
        world.admin_user.id
    )
    disabled_admin = create_user("gone-admin@example.com", role="admin", is_active=False)
    for not_a_handler in (world.alice_user.id, world.staff_user.id, world.other_owner_user.id, disabled_admin.id, 999999):
        refused = client.patch(path, json={"assignee_id": not_a_handler}, headers=world.owner)
        assert (refused.status_code, detail_code(refused)) == (422, "INVALID_ASSIGNEE"), not_a_handler
    assert client.get(path, headers=world.alice).json()["assignee"]["id"] == world.admin_user.id   # unchanged

    assert client.patch(path, json={"assignee_id": None}, headers=world.owner).json()["assignee"] is None
    assert [entry["description"] for entry in support_log(client, world, action="support_case.assigned")] == [
        f"Assigned to user {world.owner_user.id}", f"Assigned to user {world.admin_user.id}", "Assignment removed",
    ]


def test_platform_case_is_assigned_to_admins_only(client, world, platform_case):
    path = f"/support/cases/{platform_case['id']}"
    refused = client.patch(path, json={"assignee_id": world.owner_user.id}, headers=world.admin)
    assert (refused.status_code, detail_code(refused)) == (422, "INVALID_ASSIGNEE")
    done = client.patch(path, json={"assignee_id": world.admin_user.id, "status": "in_progress"}, headers=world.admin)
    assert (done.json()["assignee"]["id"], done.json()["status"]) == (world.admin_user.id, "in_progress")
    # The organizer who asked can follow it, answer, and close it, but not run it.
    assert client.get(path, headers=world.owner).json()["status"] == "in_progress"
    assert client.patch(path, json={"status": "open"}, headers=world.owner).status_code == 403
    assert client.patch(path, json={"status": "resolved"}, headers=world.owner).status_code == 200


# ------------------------------------------------------------------ history
def test_history_records_the_case_without_its_text(client, db, world, case, platform_case):
    client.post(f"/support/cases/{case['id']}/messages", json={"body": SECRET_TEXT}, headers=world.owner)
    client.patch(f"/support/cases/{case['id']}", json={"status": "in_progress"}, headers=world.owner)

    entries = support_log(client, world)
    assert [(entry["action"], entry["actor_id"], entry["entity_type"], entry["entity_id"]) for entry in entries] == [
        ("support_case.opened", world.alice_user.id, "support_case", case["id"]),
        ("support_case.status_changed", world.owner_user.id, "support_case", case["id"]),
    ]
    assert entries[0]["description"] == "Opened a support case: ticket_delivery"
    db.expire_all()
    descriptions = " ".join(db.scalars(select(ActionLog.description)).all())
    assert SECRET_TEXT not in descriptions and case["subject"] not in descriptions
    assert "example.com" not in " ".join(entry["description"] for entry in entries)

    # A platform case belongs to no event: it is in the admins' history, not in an organizer's timeline.
    platform = client.get("/admin/action-log", params={"action": "support_case.opened"}, headers=world.admin).json()
    assert {(entry["event_id"], entry["entity_id"]) for entry in platform} == {
        (world.event["id"], case["id"]), (None, platform_case["id"]),
    }
    assert all(entry["entity_id"] != platform_case["id"] for entry in support_log(client, world))


def test_refused_requests_leave_no_history(client, db, world, case):
    before = db.scalar(select(func.count()).select_from(ActionLog))
    client.patch(f"/support/cases/{case['id']}", json={"status": "in_progress"}, headers=world.alice)      # 403
    client.patch(f"/support/cases/{case['id']}", json={"assignee_id": world.alice_user.id}, headers=world.owner)  # 422
    client.patch(f"/support/cases/{case['id']}", json={"status": "resolved"}, headers=world.bob)           # 404
    open_case(client, world.bob, ticket_id=world.ticket["id"])                                             # 404
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(ActionLog)) == before
