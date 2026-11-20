from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.db.base import utcnow
from app.models import ActionLog
from tests.test_orders import shop  # noqa: F401


@pytest.fixture
def setup(client, shop):
    shop["activate"]()
    eid = shop["eid"]
    client.post(f"/events/{eid}/publish", headers=shop["org"])
    base = f"/events/{eid}/campaigns"

    def create(**changes):
        return client.post(base, headers=shop["org"], json={"name": "Autumn", "kind": "percent",
                           "value": 25, "max_uses": 1, "ticket_type_ids": [shop["paid"]], **changes})

    def quote(**params):
        return client.post(base + "/quote", json=params)

    body = {"request_id": str(uuid4()), "attendee_name": "Demo", "attendee_email": shop["buyer"].email,
            "ticket_type_id": shop["paid"]}

    def order(code):
        return client.post(f"/events/{eid}/orders", headers=shop["auth"], json={**body, "promo_code": code})

    return base, create, quote, order


def test_campaign_lifecycle(client, shop, setup, db):
    base, create, quote, order = setup
    result = create()
    assert result.status_code == 201, result.text
    item = result.json()
    code, link = item["code"], item["link"]
    assert link.startswith("https://") and code not in link
    assert quote(token=link.split("=")[1]).json()["code"] == code
    q = quote(code=code.lower(), ticket_type_id=shop["paid"]).json()
    assert (q["subtotal_tiyn"], q["discount_tiyn"], q["total_tiyn"]) == (10050, 2513, 7537)
    path = f"{base}/{item['id']}"
    svg = client.get(path + "/qr.svg", headers=shop["org"])
    assert svg.status_code == 200 and "Это не билет" in svg.text and "<path" in svg.text
    scan = client.post(f"/events/{shop['eid']}/check-in", headers=shop["org"],
                       json={"qr_payload": link, "request_id": str(uuid4())})
    assert (scan.status_code, scan.json()["detail"]["code"]) == (409, "CAMPAIGN_QR_NOT_TICKET")

    pending = order(code.lower())
    assert pending.status_code == 201, pending.text
    oid = pending.json()["id"]
    assert order(code).json()["id"] == oid
    assert order("OTHER").json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert quote(code=code).json()["detail"]["code"] == "PROMO_EXHAUSTED"
    client.patch(path, headers=shop["org"], json={"enabled": False})
    assert quote(code=code).json()["detail"]["code"] == "PROMO_DISABLED"
    paid = client.post(f"/orders/{oid}/pay", headers=shop["auth"], json={"outcome": "success"}).json()
    assert (paid["total_tiyn"], paid["processing_fee_tiyn"], paid["promo_code"]) == (7537, 226, code)
    metrics = client.get(base, headers=shop["org"]).json()[0]
    assert [metrics[k] for k in ("orders", "redemptions", "tickets_sold", "gross_tiyn", "discount_tiyn",
                                 "net_sales_tiyn", "organizer_net_tiyn")] == [1, 1, 1, 10050, 2513, 7537, 7311]
    assert {"campaign.created", "campaign.disabled"} <= set(db.scalars(select(ActionLog.action)))


def test_permissions_and_event_scoping(client, setup, shop, new_event):
    base, create, quote, _ = setup
    other = new_event(shop["org"])
    assert create(ticket_type_ids=[other["ticket_types"][0]["id"]]).status_code == 404
    item = create().json()
    path = f"{base}/{item['id']}"
    assert client.get(base, headers=shop["auth"]).status_code == 403
    assert client.get(path + "/qr.svg", headers=shop["auth"]).status_code == 403
    assert client.patch(path, headers=shop["auth"], json={"enabled": False}).status_code == 403
    assert client.patch(f"/events/{other['id']}/campaigns/{item['id']}", headers=shop["org"],
                        json={"enabled": False}).status_code == 404
    assert quote(code="UNKNOWN").json()["detail"]["code"] == "PROMO_NOT_FOUND"
    assert quote(code=item["code"], ticket_type_id=shop["free"]).json()["detail"]["code"] == "PROMO_NOT_APPLICABLE"
    assert quote(code=item["code"], ticket_type_id=other["ticket_types"][0]["id"]).status_code == 404


@pytest.mark.parametrize("field,days,reason", [("starts_at", 1, "PROMO_NOT_STARTED"), ("ends_at", -1, "PROMO_EXPIRED")])
def test_campaign_window(setup, field, days, reason):
    _, create, quote, order = setup
    item = create(**{field: (utcnow() + timedelta(days=days)).isoformat()}).json()
    for result in (quote(code=item["code"]), order(item["code"])):
        assert result.status_code == 409 and result.json()["detail"]["code"] == reason


@pytest.mark.parametrize("outcome", ["failure", "cancel"])
def test_full_discount_and_released_use(client, setup, shop, outcome):
    _, create, quote, order = setup
    item = create(kind="fixed", value=999999).json()
    pending = order(item["code"]).json()
    assert pending["total_tiyn"] == pending["processing_fee_tiyn"] == 0
    path = f"/orders/{pending['id']}"
    if outcome == "cancel":
        client.post(path + "/cancel", headers=shop["auth"])
    else:
        client.post(path + "/pay", headers=shop["auth"], json={"outcome": "failure"})
    assert quote(code=item["code"]).status_code == 200
