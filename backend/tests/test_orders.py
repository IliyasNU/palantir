from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select, func

from app import email, notifications
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


def test_organizer_can_close_a_free_registration_but_cannot_bypass_a_paid_refund(client, shop, login_as, db):
    base = f"/events/{shop['eid']}"
    _, other = login_as("another-guest@example.com")
    free_ticket = client.post(base + "/tickets", headers=other, json={"ticket_type_id": shop["free"]})
    assert free_ticket.status_code == 201, free_ticket.text
    free_id = free_ticket.json()["id"]
    shop["activate"]()
    order_id = shop["checkout"]().json()["id"]
    paid = client.post(f"/orders/{order_id}/pay", json={"outcome": "success"}, headers=shop["auth"])
    assert paid.status_code == 200, paid.text
    paid_id = paid.json()["ticket_id"]
    assert client.get(base + "/orders/manage", headers=shop["auth"]).status_code == 403
    response = client.get(base + "/orders/manage", headers=shop["org"])
    assert response.status_code == 200, response.text
    assert [ticket["id"] for ticket in response.json()["free_registrations"]] == [free_id]
    assert [order["id"] for order in response.json()["orders"]] == [order_id]
    for action in ("cancel", "refund"):
        bypass = client.post(f"/tickets/{paid_id}/{action}", headers=shop["org"])
        assert bypass.status_code == 409 and bypass.json()["detail"]["code"] == "PAID_ORDER_REQUIRES_REFUND"
    cancelled = client.post(f"/tickets/{free_id}/cancel", headers=shop["org"])
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    counters(db, shop, 1, tickets=2)
    assert db.get(TicketType, shop["free"]).tickets_issued == 0
    assert db.scalar(select(func.count()).select_from(ActionLog).where(
        ActionLog.event_id == shop["eid"], ActionLog.action == "ticket.cancelled", ActionLog.entity_id == free_id,
    )) == 1


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


# ------------------------------------------------------------------ order emails (BE-3c)
@pytest.fixture()
def outbox(monkeypatch):
    sent = []
    monkeypatch.setattr(email, "send_email", lambda to, subject, body, attachment=None: sent.append(
        {"to": to, "subject": subject, "body": body, "attachment": attachment}))
    return sent


def kinds(client, headers):
    return [item["kind"] for item in client.get("/notifications/me", headers=headers).json()]


def test_a_paid_order_emails_the_ticket_pdf_once(client, shop, outbox):
    shop["activate"]()
    oid = shop["checkout"]().json()["id"]
    outbox.clear()
    for outcome in ("success", "success", "failure"):  # the first result wins and only it sends
        ticket_id = client.post(f"/orders/{oid}/pay", headers=shop["auth"], json={"outcome": outcome}).json()["ticket_id"]
    [sent] = outbox
    assert sent["to"] == "buyer@example.com" and f"Заказ №{oid} оплачен" in sent["subject"]
    assert "100,50 ₸" in sent["body"] and "Демонстрационная оплата" in sent["body"]
    filename, pdf = sent["attachment"]
    assert filename == f"biletflow-ticket-{ticket_id}.pdf" and pdf.startswith(b"%PDF")
    [item] = client.get("/notifications/me", headers=shop["auth"]).json()
    assert (item["kind"], item["link"]) == ("order.paid", f"/tickets/{ticket_id}")


def test_tenge_format():
    assert (notifications._tenge(10050), notifications._tenge(123456705)) == ("100,50 ₸", "1\u00a0234\u00a0567,05 ₸")


def test_a_failed_payment_emails_once(client, shop, outbox):
    shop["activate"]()
    oid = shop["checkout"]().json()["id"]
    outbox.clear()
    for outcome in ("failure", "failure", "success"):
        client.post(f"/orders/{oid}/pay", headers=shop["auth"], json={"outcome": outcome})
    [sent] = outbox
    assert f"Оплата заказа №{oid} не прошла" == sent["subject"] and sent["attachment"] is None
    assert "Место освобождено" in sent["body"]
    assert kinds(client, shop["auth"]) == ["payment.failed"]


def test_no_payment_no_email(client, shop, db, outbox):
    shop["activate"]()
    expired = shop["checkout"]().json()["id"]
    db.get(Order, expired).expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    assert client.post(f"/orders/{expired}/pay", headers=shop["auth"], json={"outcome": "success"}).status_code == 409

    refused = shop["checkout"]().json()["id"]
    db.get(Event, shop["eid"]).suspended_at = utcnow()
    db.commit()
    assert client.post(f"/orders/{refused}/pay", headers=shop["auth"], json={"outcome": "success"}).status_code >= 400
    assert client.post(f"/orders/{refused}/cancel", headers=shop["auth"]).status_code == 200
    assert outbox == [] and kinds(client, shop["auth"]) == []


def test_free_registration_issues_one_receipt_without_payment(client, shop):
    base = f"/events/{shop['eid']}"
    first = client.post(base + "/tickets", headers=shop["auth"], json={"ticket_type_id": shop["free"]})
    assert first.status_code == 201
    replay = client.post(base + "/tickets", headers=shop["auth"])
    assert replay.status_code == 200 and replay.json()["id"] == first.json()["id"]
    [order] = client.get("/orders/me", headers=shop["auth"]).json()
    assert (order["status"], order["ticket_id"], order["subtotal_tiyn"], order["total_tiyn"]) == (
        "paid", first.json()["id"], 0, 0)
    assert order["expires_at"] is order["completed_at"] is order["promo_code"] is order["demo_notice"] is None
    assert order["simulation"] is False
    assert order["processing_fee_tiyn"] == order["discount_tiyn"] == 0
    rejected = client.post(f"{base}/orders/{order['id']}/refund", headers=shop["org"])
    assert rejected.status_code == 409 and rejected.json()["detail"]["code"] == "FREE_REGISTRATION"
    assert client.post(base + "/cancel", headers=shop["org"]).status_code == 200
    assert client.post(base + "/orders/refund-all", headers=shop["org"]).json() == {"refunded_count": 0, "refunds_tiyn": 0}
