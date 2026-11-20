"""Refund accounting, concurrent admission and atomic event-wide refunds on PostgreSQL."""
from uuid import uuid4

import pytest

from e2e.conftest import run_concurrently
from e2e.test_orders import assert_counts, paid_shop  # noqa: F401


def buy(api, shop, buyer=None, promo_code=None):
    buyer = buyer or shop["buyer"]
    body = shop["body"]() | {"attendee_email": buyer.email}
    if promo_code:
        body["promo_code"] = promo_code
    response = api.post(f"/events/{shop['eid']}/orders", headers=buyer.headers, json=body)
    assert response.status_code == 201, response.text
    order_id = response.json()["id"]
    response = api.post(f"/orders/{order_id}/pay", headers=buyer.headers, json={"outcome": "success"})
    assert response.status_code == 200, response.text
    order = response.json()
    ticket = api.get(f"/tickets/{order['ticket_id']}", headers=buyer.headers).json()
    return order, ticket


def scan(api, shop, ticket):
    return api.post(f"/events/{shop['eid']}/check-in", headers=shop["owner"].headers,
                    json={"qr_payload": ticket["qr_payload"], "request_id": str(uuid4())})


def refund(api, shop, order):
    return api.post(f"/events/{shop['eid']}/orders/{order['id']}/refund", headers=shop["owner"].headers)


def refund_notices(api, buyer, order):
    response = api.get("/notifications/me", headers=buyer.headers)
    assert response.status_code == 200, response.text
    return [x for x in response.json()
            if x["kind"] == "REFUND_COMPLETED" and x["link"] == f"/orders/{order['id']}"]


@pytest.mark.parametrize("attempt", range(3))
def test_paid_refund_racing_check_in_has_exactly_one_outcome(api, paid_shop, sql, attempt):
    shop = paid_shop
    order, ticket = buy(api, shop)
    returned, admitted = run_concurrently([
        lambda c: refund(c, shop, order),
        lambda c: scan(c, shop, ticket),
    ])
    assert sorted([returned.status_code, admitted.status_code]) == [200, 409]
    refund_won = returned.status_code == 200
    if refund_won:
        assert admitted.json()["detail"]["code"] == "TICKET_REFUNDED"
        assert returned.json()["refunded_at"]
    else:
        assert returned.json()["detail"]["code"] == "TICKET_CHECKED_IN"
    assert sql("SELECT status FROM orders WHERE id=:id", id=order["id"]) == ("refunded" if refund_won else "paid")
    assert sql("SELECT status FROM tickets WHERE id=:id", id=ticket["id"]) == ("refunded" if refund_won else "active")
    assert sql("SELECT count(*) FROM check_ins WHERE ticket_id=:id AND undone_at IS NULL",
               id=ticket["id"]) == (0 if refund_won else 1)
    assert sql("SELECT count(*) FROM action_logs WHERE event_id=:id AND action='order.refunded'",
               id=shop["eid"]) == int(refund_won)
    assert len(refund_notices(api, shop["buyer"], order)) == int(refund_won)
    assert_counts(sql, shop["eid"])


def test_full_discounted_refund_is_idempotent_and_releases_seat(api, paid_shop, register, sql):
    shop = paid_shop
    owner, buyer, event_id = shop["owner"], shop["buyer"], shop["eid"]
    policy = "Full demo refunds on request."
    response = api.patch(f"/events/{event_id}", headers=owner.headers, json={"refund_policy": policy})
    assert response.status_code == 200, response.text
    assert api.get(f"/events/{event_id}").json()["refund_policy"] == policy
    campaign = api.post(f"/events/{event_id}/campaigns", headers=owner.headers,
                        json={"name": "Refund test", "kind": "fixed", "value": 50, "max_uses": 1})
    assert campaign.status_code == 201, campaign.text
    order, ticket = buy(api, shop, promo_code=campaign.json()["code"])
    assert order["total_tiyn"] == 10000
    returned = run_concurrently([lambda c: refund(c, shop, order)] * 2)
    assert all(r.status_code == 200 for r in returned), [r.text for r in returned]
    assert returned[0].json()["refunded_at"] == returned[1].json()["refunded_at"]
    received = api.get(f"/orders/{order['id']}", headers=buyer.headers).json()
    assert (received["status"], received["ticket_id"], received["total_tiyn"]) == ("refunded", ticket["id"], 10000)
    assert scan(api, shop, ticket).json()["detail"]["code"] == "TICKET_REFUNDED"
    assert len(refund_notices(api, buyer, order)) == 1
    assert sql("SELECT count(*) FROM action_logs WHERE event_id=:id AND action='order.refunded'", id=event_id) == 1
    summary = api.get(f"/events/{event_id}/orders/summary", headers=owner.headers).json()
    assert (summary["gross_sales_tiyn"], summary["refunds_tiyn"], summary["estimated_payout_tiyn"]) == (10000, 10000, 0)
    assert_counts(sql, event_id)
    replacement, _ = buy(api, shop, buyer=register())
    assert replacement["status"] == "paid"
    assert_counts(sql, event_id)


def test_cancelled_event_refunds_all_orders_atomically_after_undo(api, paid_shop, register, sql):
    shop = paid_shop
    owner, event_id = shop["owner"], shop["eid"]
    assert api.patch(f"/events/{event_id}/ticket-types/{shop['free']}", headers=owner.headers,
                     json={"quantity": 0}).status_code == 200
    assert api.patch(f"/events/{event_id}/ticket-types/{shop['paid']}", headers=owner.headers,
                     json={"quantity": 2}).status_code == 200
    second_buyer = register()
    order_one, _ = buy(api, shop)
    order_two, ticket_two = buy(api, shop, buyer=second_buyer)
    scan_result = scan(api, shop, ticket_two)
    assert scan_result.status_code == 200, scan_result.text
    path = f"/events/{event_id}/orders/refund-all"
    assert api.post(path, headers=owner.headers).status_code == 409
    assert api.post(f"/events/{event_id}/cancel", headers=owner.headers).status_code == 200
    refused = api.post(path, headers=owner.headers)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "TICKET_CHECKED_IN"
    assert sql("SELECT count(*) FROM orders WHERE event_id=:id AND status='paid'", id=event_id) == 2
    check_id = scan_result.json()["check_in_id"]
    undone = api.post(f"/events/{event_id}/check-ins/{check_id}/undo", headers=owner.headers,
                      json={"request_id": str(uuid4())})
    assert undone.status_code == 200, undone.text
    first = api.post(path, headers=owner.headers)
    assert first.status_code == 200, first.text
    assert first.json() == {"refunded_count": 2, "refunds_tiyn": 20100}
    assert api.post(path, headers=owner.headers).json() == {"refunded_count": 0, "refunds_tiyn": 0}
    assert len(refund_notices(api, shop["buyer"], order_one)) == len(refund_notices(api, second_buyer, order_two)) == 1
    assert sql("SELECT count(*) FROM tickets WHERE event_id=:id AND status='refunded'", id=event_id) == 2
    assert_counts(sql, event_id)
