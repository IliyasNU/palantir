from datetime import datetime, timezone
from uuid import uuid4

from app.models import Order, Ticket
from tests.test_orders import shop  # noqa: F401


def test_analytics_rolls_up_sales_refunds_campaigns_and_attendance(client, db, shop, login_as):
    event_id, owner = shop["eid"], shop["org"]
    base = f"/events/{event_id}"
    url = base + "/analytics"
    shop["activate"]()
    created = client.post(base + "/campaigns", headers=owner,
                          json={"name": "Spring", "kind": "percent", "value": 25, "max_uses": 5})
    assert created.status_code == 201, created.text
    campaign = created.json()
    _, other = login_as("report-buyer@example.com")
    _, free = login_as("report-guest@example.com")
    _, pending = login_as("report-hold@example.com")

    def checkout(headers, email, promo=True):
        response = client.post(base + "/orders", headers=headers, json={
            "request_id": str(uuid4()), "attendee_name": "Analytics Buyer", "attendee_email": email,
            "ticket_type_id": shop["paid"], **({"promo_code": campaign["code"]} if promo else {}),
        })
        assert response.status_code == 201, response.text
        return response.json()["id"]

    paid = checkout(shop["auth"], shop["buyer"].email)
    refunded = checkout(other, "report-buyer@example.com")
    for order_id, headers in [(paid, shop["auth"]), (refunded, other)]:
        result = client.post(f"/orders/{order_id}/pay", headers=headers, json={"outcome": "success"})
        assert result.status_code == 200, result.text
    result = client.post(base + f"/orders/{refunded}/refund", headers=owner)
    assert result.status_code == 200, result.text
    checkout(pending, "report-hold@example.com", promo=False)

    free_ticket = client.post(base + "/tickets", headers=free, json={"ticket_type_id": shop["free"]})
    assert free_ticket.status_code == 201, free_ticket.text
    guest = free_ticket.json()
    result = client.post(base + "/check-in", headers=owner,
                         json={"qr_payload": guest["qr_payload"], "request_id": str(uuid4())})
    assert result.status_code == 200, result.text
    db.get(Order, refunded).completed_at = datetime(2026, 1, 1, 23, 55, tzinfo=timezone.utc)
    db.get(Order, paid).completed_at = datetime(2026, 1, 2, 23, 55, tzinfo=timezone.utc)
    db.get(Ticket, guest["id"]).created_at = datetime(2026, 1, 2, 8, tzinfo=timezone.utc)
    db.commit()

    response = client.get(url, headers=owner)
    assert response.status_code == 200, response.text
    report = response.json()
    expected = {
        "capacity": 4, "sold": 2, "remaining": 1, "percent_sold": 50.0,
        "gross_before_discount_tiyn": 20100, "gross_sales_tiyn": 15074, "discounts_tiyn": 5026,
        "refunds_tiyn": 7537, "net_sales_tiyn": 7537, "processing_fees_tiyn": 226,
        "estimated_payout_tiyn": 7311, "checked_in": 1, "absent": 1, "percent_checked_in": 50.0,
    }
    assert {key: report[key] for key in expected} == expected
    assert [(row["date"], row["sold"], row["refunds_tiyn"], row["net_sales_tiyn"]) for row in report["daily"]] == [
        ("2026-01-01", 0, 7537, 0), ("2026-01-02", 2, 0, 7537),
    ]
    assert [(row["id"], row["sold"], row["checked_in"], row["net_sales_tiyn"]) for row in report["ticket_types"]] == [
        (shop["free"], 1, 1, 0), (shop["paid"], 1, 0, 7537),
    ]
    assert [(row["id"], row["redemptions"], row["sold"], row["net_sales_tiyn"]) for row in report["campaigns"]] == [
        (campaign["id"], 1, 1, 7537),
    ]
    summary = client.get(base + "/orders/summary", headers=owner).json()
    for key in ("gross_before_discount_tiyn", "gross_sales_tiyn", "discounts_tiyn", "refunds_tiyn", "net_sales_tiyn", "estimated_payout_tiyn"):
        assert summary[key] == report[key]
    paid_only = client.get(url, headers=owner, params={
        "ticket_type_id": shop["paid"], "date_from": "2026-01-02", "date_to": "2026-01-02",
    }).json()
    assert (paid_only["capacity"], paid_only["sold"], paid_only["remaining"], paid_only["percent_sold"]) == (2, 1, 0, 50.0)
    assert paid_only["discounts_tiyn"] == 2513 and paid_only["refunds_tiyn"] == 0
    assert paid_only["checked_in"] == 0 and paid_only["absent"] == 1
    assert list(row["id"] for row in paid_only["ticket_types"]) == [shop["paid"]]
    assert client.get(url, headers=shop["admin"]).json() == report
    assert client.get(url, headers=other).status_code == 404


def test_analytics_empty_event_and_filter_errors(client, shop):
    url = f"/events/{shop['eid']}/analytics"
    empty = client.get(url, headers=shop["org"]).json()
    assert (empty["remaining"], empty["sold"], empty["checked_in"], empty["absent"]) == (4, 0, 0, 0)
    assert empty["daily"] == empty["campaigns"] == []
    for key in ("gross_before_discount_tiyn", "discounts_tiyn", "refunds_tiyn", "net_sales_tiyn", "percent_sold", "percent_checked_in"):
        assert empty[key] == 0
    missing = client.get(url, headers=shop["org"], params={"ticket_type_id": 9999})
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "TICKET_TYPE_NOT_FOUND"
    invalid = client.get(url, headers=shop["org"], params={"date_from": "2026-11-20", "date_to": "2026-11-19"})
    assert invalid.status_code == 422 and invalid.json()["detail"]["code"] == "INVALID_DATE_RANGE"
