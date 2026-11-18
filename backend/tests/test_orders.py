from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select, func

from app.db.base import utcnow
from app.demo_fees import processing_fee
from app.models import Event, Ticket, TicketType, ActionLog
from app.models.order import Order


@pytest.fixture()
def shop(client, login_as, new_event):
    owner, org = login_as("owner@example.com", "organizer")
    buyer, auth = login_as("buyer@example.com")
    _, admin = login_as("admin@example.com", "admin")
    event = new_event(org, capacity=4)
    eid = event["id"]
    free = event["ticket_types"][0]["id"]
    assert client.patch(f"/events/{eid}/ticket-types/{free}", headers=org, json={"quantity": 2}).status_code == 200
    response = client.post(f"/events/{eid}/ticket-types", headers=org,
                           json={"name": "Paid", "price_tiyn": 10050, "quantity": 2})
    assert response.status_code == 201, response.text
    paid = response.json()["id"]
    assert client.post("/organizer-profiles", headers=org, json={"organization_name": "Demo"}).status_code == 201
    def activate():
        for route, body in (("/organizer-profiles/me/confirm-identity", None),
                            ("/organizer-profiles/me/payout-details", {"reference_last4": "D123"}),
                            (f"/events/{eid}/activation/terms", None), (f"/events/{eid}/activation/fee", None)):
            result = client.post(route, headers=org, json=body)
            assert result.status_code == 200, result.text
        return result.json()
    def checkout(key=None):
        return client.post(f"/events/{eid}/orders", headers=auth, json={"ticket_type_id": paid,
                           "attendee_name": "Demo Buyer", "attendee_email": buyer.email, "request_id": str(key or uuid4())})
    return dict(owner=owner, buyer=buyer, org=org, auth=auth, admin=admin, eid=eid, free=free, paid=paid,
                activate=activate, checkout=checkout)


def counters(db, shop, expected, tickets=0):
    db.expire_all()
    assert db.get(Event, shop["eid"]).tickets_issued == expected
    assert db.get(TicketType, shop["paid"]).tickets_issued == expected
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.event_id == shop["eid"])) == tickets


@pytest.mark.parametrize("amount,expected", [(1, 0), (16, 0), (17, 1), (50, 2), (99, 3), (10050, 302), (2147483647, 64424509)])
def test_integer_fee_rounding(amount, expected):
    assert processing_fee(amount) == expected


def test_activation_is_per_event_and_steps_idempotent(client, shop, new_event, db):
    before = client.get(f"/events/{shop['eid']}/activation", headers=shop["org"]).json()
    assert not before["activated"] and before["steps"]["paid_type"]["done"]
    result = shop["activate"]()
    assert result["activated"] and result["fee_paid_tiyn"] == 500000 and result["simulation"]
    assert all(step["done"] for step in result["steps"].values())
    shop["activate"]()
    for action in ("paid_sales.terms_accepted", "paid_sales.fee_paid", "paid_sales.activated"):
        assert db.scalar(select(func.count()).select_from(ActionLog).where(ActionLog.action == action)) == 1
    other = new_event(shop["org"])
    assert not client.get(f"/events/{other['id']}/activation", headers=shop["org"]).json()["activated"]
    assert client.get(f"/events/{shop['eid']}/activation", headers=shop["auth"]).status_code == 403
    assert client.post("/organizer-profiles/me/payout-details", headers=shop["org"],
                       json={"reference_last4": "123456789"}).status_code == 422


def test_checkout_pay_idempotence_and_snapshot(client, shop, db):
    shop["activate"]()
    key = uuid4()
    created = shop["checkout"](key)
    assert created.status_code == 201, created.text
    order = created.json()
    assert order["total_tiyn"] == 10050 and order["processing_fee_tiyn"] == 302
    assert shop["checkout"](key).json()["id"] == order["id"]
    counters(db, shop, 1)
    assert shop["checkout"]().json()["detail"]["code"] == "PENDING_ORDER_EXISTS"
    assert client.post(f"/events/{shop['eid']}/tickets", headers=shop["auth"],
                       json={"ticket_type_id": shop["free"]}).json()["detail"]["code"] == "PENDING_ORDER_EXISTS"
    client.patch(f"/events/{shop['eid']}/ticket-types/{shop['paid']}", headers=shop["org"], json={"price_tiyn": 12000})
    url = f"/orders/{order['id']}/pay"
    paid = client.post(url, headers=shop["auth"], json={"outcome": "success"})
    assert paid.status_code == 200, paid.text
    assert paid.json()["total_tiyn"] == 10050 and paid.json()["ticket_id"]
    assert client.post(url, headers=shop["auth"], json={"outcome": "failure"}).json() == paid.json()
    counters(db, shop, 1, 1)
    summary = client.get(f"/events/{shop['eid']}/orders/summary", headers=shop["org"]).json()
    assert summary["estimated_payout_tiyn"] == 9748 and summary["refunds_tiyn"] == 0 and summary["simulation"]
    assert shop["checkout"]().json()["detail"]["code"] == "ACTIVE_TICKET_EXISTS"


@pytest.mark.parametrize("action", ["failure", "cancel"])
def test_failed_cancelled_order_releases_once(client, shop, db, action):
    shop["activate"]()
    oid = shop["checkout"]().json()["id"]
    for _ in range(2):
        response = client.post(f"/orders/{oid}/{'pay' if action == 'failure' else 'cancel'}", headers=shop["auth"],
                               json={"outcome": "failure"} if action == "failure" else None)
        assert response.status_code == 200
    counters(db, shop, 0)
    assert client.post(f"/orders/{oid}/pay", headers=shop["auth"], json={"outcome": "success"}).json()["ticket_id"] is None


def test_expiry_is_persistent_and_does_not_block_free_claim(client, shop, db):
    shop["activate"]()
    oid = shop["checkout"]().json()["id"]
    db.get(Order, oid).expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    for _ in range(2):
        result = client.post(f"/orders/{oid}/pay", headers=shop["auth"], json={"outcome": "success"})
        assert result.status_code == 409 and result.json()["detail"]["code"] == "ORDER_EXPIRED"
        assert client.get(f"/orders/{oid}", headers=shop["auth"]).json()["status"] == "expired"
    counters(db, shop, 0)
    response = client.post(f"/events/{shop['eid']}/tickets", headers=shop["auth"], json={"ticket_type_id": shop["free"]})
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("state", ["cancelled", "refunded"])
def test_closed_ticket_blocks_checkout_but_legacy_replays(client, shop, db, state):
    shop["activate"]()
    ticket = client.post(f"/events/{shop['eid']}/tickets", headers=shop["auth"], json={"ticket_type_id": shop["free"]}).json()
    route = "cancel" if state == "cancelled" else "refund"
    assert client.post(f"/tickets/{ticket['id']}/{route}", headers=shop["org"]).status_code == 200
    response = shop["checkout"]()
    assert response.status_code == 409 and response.json()["detail"]["code"] == "CLOSED_TICKET_EXISTS"
    replay = client.post(f"/events/{shop['eid']}/tickets", headers=shop["auth"])
    assert replay.status_code == 200 and replay.json()["status"] == state


def test_orders_are_private_even_to_admin(client, shop):
    shop["activate"]()
    oid = shop["checkout"]().json()["id"]
    for headers in (shop["org"], shop["admin"]):
        for method, route, body in (("get", "", None), ("post", "/pay", {"outcome": "success"}), ("post", "/cancel", None)):
            response = getattr(client, method)(f"/orders/{oid}{route}", headers=headers,
                                                **({"json": body} if method == "post" else {}))
            assert response.status_code == 404
    assert len(client.get("/orders/me", headers=shop["auth"]).json()) == 1
    assert client.get("/orders/me", headers=shop["org"]).json() == []


@pytest.mark.parametrize("condition,code", [
    ("activation", "PAID_SALES_NOT_ACTIVATED"), ("suspended", "EVENT_SUSPENDED"),
    ("draft", "EVENT_NOT_PUBLISHED"), ("cancelled", "EVENT_CANCELLED"),
    ("hidden", "TICKET_TYPE_HIDDEN"), ("future", "TICKET_TYPE_SALES_NOT_STARTED"),
    ("past", "TICKET_TYPE_SALES_ENDED"), ("full", "SOLD_OUT"), ("type_full", "TICKET_TYPE_SOLD_OUT"),
])
def test_checkout_refusals(client, shop, db, condition, code):
    if condition != "activation":
        shop["activate"]()
    event = db.get(Event, shop["eid"])
    kind = db.get(TicketType, shop["paid"])
    if condition == "suspended": event.suspended_at = utcnow()
    elif condition in ("draft", "cancelled"): event.status = condition
    elif condition == "hidden": kind.hidden = True
    elif condition == "future": kind.sales_start = utcnow() + timedelta(hours=1)
    elif condition == "past": kind.sales_end = utcnow() - timedelta(hours=1)
    elif condition == "full": event.tickets_issued = event.capacity
    elif condition == "type_full": kind.tickets_issued = kind.quantity
    db.commit()
    result = shop["checkout"]()
    assert result.status_code == 409 and result.json()["detail"]["code"] == code, result.text
    assert db.scalar(select(func.count()).select_from(Order)) == 0


def test_paid_suspension_keeps_free_claims_and_prevents_payment(client, shop, db):
    shop["activate"]()
    oid = shop["checkout"]().json()["id"]
    route = f"/admin/events/{shop['eid']}/paid-sales"
    assert client.post(route + "/suspend", headers=shop["org"], json={"reason": "Demo"}).status_code == 403
    assert client.post(route + "/suspend", headers=shop["admin"], json={}).status_code == 422
    assert client.post(route + "/suspend", headers=shop["admin"], json={"reason": "Demo pause"}).status_code == 200
    assert client.post(f"/orders/{oid}/pay", headers=shop["auth"], json={"outcome": "success"}).json()["detail"]["code"] == "PAID_SALES_SUSPENDED"
    assert shop["checkout"]().json()["detail"]["code"] == "PAID_SALES_SUSPENDED"
    assert client.post(f"/events/{shop['eid']}/tickets", headers=shop["org"], json={"ticket_type_id": shop["free"]}).status_code == 201
    assert client.post(route + "/restore", headers=shop["admin"]).status_code == 200
    assert client.post(f"/orders/{oid}/pay", headers=shop["auth"], json={"outcome": "success"}).json()["status"] == "paid"


def test_foreign_free_type_and_request_conflict(client, shop, new_event):
    shop["activate"]()
    other = new_event(shop["org"])
    body = {"ticket_type_id": other["ticket_types"][0]["id"], "attendee_name": "Name", "attendee_email": "a@example.com", "request_id": str(uuid4())}
    route = f"/events/{shop['eid']}/orders"
    assert client.post(route, headers=shop["auth"], json=body).json()["detail"]["code"] == "TICKET_TYPE_NOT_FOUND"
    body["ticket_type_id"] = shop["free"]
    assert client.post(route, headers=shop["auth"], json=body).json()["detail"]["code"] == "FREE_TICKET_USE_CLAIM"
    body["ticket_type_id"] = shop["paid"]
    assert client.post(route, headers=shop["auth"], json=body).status_code == 201
    body["attendee_name"] = "Different"
    assert client.post(route, headers=shop["auth"], json=body).json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
