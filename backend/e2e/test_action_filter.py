"""The action filter of both histories on PostgreSQL: a whole action or the group before its dot, never a raw prefix."""
import uuid

import pytest

from e2e.test_suspension import admin  # noqa: F401  (the fixture that promotes a fresh account to admin)

EXPECTED = [
    ("ticket", ["ticket.cancelled"]),
    ("ticket_type", ["ticket_type.created"]),
    ("ticket.cancelled", ["ticket.cancelled"]),
    ("check", []),
    ("check_in", ["check_in.created"]),
    ("ticket.", ["ticket.cancelled"]),
    # "_" and "%" are literal in PostgreSQL LIKE as well.
    ("ticket_", []),
    ("ticket%", []),
    ("check_in%", []),
    ("check.in", []),
]


@pytest.fixture()
def mixed_event(api, register, published_event):
    """An event whose history holds ticket_type.created, check_in.created and ticket.cancelled."""
    owner, visitor, leaver = register("organizer"), register(), register()
    event_id = published_event(owner, capacity=5)["id"]
    ticket = api.post(f"/events/{event_id}/tickets", headers=visitor.headers).json()
    scanned = api.post(
        f"/events/{event_id}/check-in",
        json={"qr_payload": ticket["qr_payload"], "request_id": str(uuid.uuid4())},
        headers=owner.headers,
    )
    assert scanned.status_code == 200, scanned.text
    returned = api.post(f"/events/{event_id}/tickets", headers=leaver.headers).json()
    cancelled = api.post(f"/tickets/{returned['id']}/cancel", headers=leaver.headers)
    assert cancelled.status_code == 200, cancelled.text
    everything = api.get(f"/events/{event_id}/action-log", headers=owner.headers).json()
    assert [entry["action"] for entry in reversed(everything)] == [
        "event.created", "ticket_type.created", "event.published", "check_in.created", "ticket.cancelled",
    ]
    return owner, event_id


def test_action_filter_selects_whole_actions_and_groups_on_both_histories(api, admin, mixed_event):  # noqa: F811
    owner, event_id = mixed_event
    for action, expected in EXPECTED:
        timeline = api.get(f"/events/{event_id}/action-log", params={"action": action}, headers=owner.headers)
        assert timeline.status_code == 200, timeline.text
        assert [entry["action"] for entry in timeline.json()] == expected, action
        platform = api.get(
            "/admin/action-log", params={"action": action, "event_id": event_id}, headers=admin.headers
        )
        assert platform.status_code == 200, platform.text
        assert [entry["action"] for entry in platform.json()] == expected, action
