"""A paid and admitted ticket stays on its original event when the organizer duplicates it."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import text

from e2e.test_orders import paid_shop  # noqa: F401


def test_duplicate_preserves_settings_without_copying_live_history(api, paid_shop, db_engine, sql):
    shop = paid_shop
    event_id = shop["eid"]
    owner = shop["owner"].headers
    buyer = shop["buyer"].headers
    original = api.get(f"/events/{event_id}", headers=owner).json()

    reservation = api.post(f"/events/{event_id}/orders", headers=buyer, json=shop["body"]())
    assert reservation.status_code == 201, reservation.text
    order_id = reservation.json()["id"]
    payment = api.post(f"/orders/{order_id}/pay", headers=buyer, json={"outcome": "success"})
    assert payment.status_code == 200, payment.text
    ticket_id = payment.json()["ticket_id"]
    ticket = api.get(f"/tickets/{ticket_id}", headers=buyer).json()
    check_in = api.post(
        f"/events/{event_id}/check-in",
        headers=owner,
        json={"qr_payload": ticket["qr_payload"], "request_id": str(uuid4())},
    )
    assert check_in.status_code == 200, check_in.text

    # Time passes after payment and admission. No lifecycle update API is bypassed outside the test database.
    with db_engine.begin() as connection:
        connection.execute(text("UPDATE events SET date=created_at-interval '2 days' WHERE id=:id"), {"id": event_id})

    history_path = f"/events/{event_id}/history"
    assert api.get(history_path, headers=buyer).status_code == 403
    result = api.get(history_path, headers=owner)
    assert result.status_code == 200, result.text
    history = result.json()
    assert history["event"]["phase"] == "completed"
    assert [row["id"] for row in history["tickets"]] == [ticket_id]
    assert [row["id"] for row in history["orders"]] == [order_id]
    assert [row["ticket_id"] for row in history["check_ins"]] == [ticket_id]
    assert "qr_payload" not in history["tickets"][0]

    new_date = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    result = api.post(f"/events/{event_id}/duplicate", headers=owner, json={"date": new_date})
    assert result.status_code == 201, result.text
    draft = result.json()
    draft_id = draft["id"]
    assert draft_id != event_id
    assert (draft["status"], draft["phase"], draft["tickets_issued"]) == ("draft", "upcoming", 0)
    for field in ("title", "description", "capacity", "location"):
        assert draft[field] == original[field]

    fields = ("name", "description", "quantity", "price_tiyn", "order_limit", "hidden")
    original_types = {tuple(row[f] for f in fields) for row in original["ticket_types"]}
    assert len(original_types) == 2
    assert {tuple(row[f] for f in fields) for row in draft["ticket_types"]} == original_types
    assert {row["id"] for row in draft["ticket_types"]}.isdisjoint(row["id"] for row in original["ticket_types"])
    assert all(row["tickets_issued"] == 0 for row in draft["ticket_types"])
    for table in ("orders", "tickets", "check_ins", "paid_sales_activations"):
        assert sql(f"SELECT count(*) FROM {table} WHERE event_id=:id", id=draft_id) == 0

    audit = api.get(f"/events/{draft_id}/action-log", headers=owner)
    assert audit.status_code == 200, audit.text
    assert any(row["action"] == "event.duplicated" and row["entity_id"] == draft_id for row in audit.json())
    assert api.get(history_path, headers=owner).json() == history
