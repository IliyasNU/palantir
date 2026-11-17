"""SRS 4.14 / success criterion: the admission endpoint never accepts a Campaign QR as permission to enter."""
import uuid

import pytest

CAMPAIGN_STYLE_PAYLOADS = [
    "https://biletflow.kz/events/1?campaign=SPRING25",
    "https://biletflow.kz/c/9f2b7c1e4d",
    "biletflow:campaign:v1:9f2b7c1e4d",
    "SPRING25",
]


def scan(api, event_id, qr_payload, staff):
    body = {"qr_payload": qr_payload, "request_id": str(uuid.uuid4())}
    return api.post(f"/events/{event_id}/check-in", json=body, headers=staff.headers)


@pytest.mark.parametrize("payload", CAMPAIGN_STYLE_PAYLOADS)
def test_campaign_link_is_refused_and_records_nothing(api, register, published_event, sql, payload):
    owner, attendee = register("organizer"), register()
    event_id = published_event(owner)["id"]
    ticket = api.post(f"/events/{event_id}/tickets", headers=attendee.headers).json()

    for candidate in (payload, f"https://biletflow.kz/events/{event_id}?ticket={ticket['qr_payload']}"):
        response = scan(api, event_id, candidate, owner)
        assert response.status_code == 404, response.text
        assert response.json()["detail"]["code"] == "INVALID_TICKET"

    assert sql("SELECT count(*) FROM check_ins WHERE event_id = :id", id=event_id) == 0
    assert sql(
        "SELECT count(*) FROM action_logs WHERE event_id = :id AND action = 'check_in.created'", id=event_id
    ) == 0
    assert api.get(f"/events/{event_id}/attendance", headers=owner.headers).json()["checked_in"] == 0

    # A valid ticket QR keeps working next to the refused links.
    assert scan(api, event_id, ticket["qr_payload"], owner).status_code == 200
    assert sql("SELECT count(*) FROM check_ins WHERE event_id = :id", id=event_id) == 1
