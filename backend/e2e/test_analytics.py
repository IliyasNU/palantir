from uuid import uuid4

from sqlalchemy import text

from e2e.test_orders import paid_shop  # noqa: F401
from e2e.test_refunds import buy, refund


def test_analytics_reads_refund_and_discount_on_utc_sales_day(api, paid_shop, db_engine):
    shop = paid_shop
    owner = shop["owner"].headers
    base = f"/events/{shop['eid']}"
    created = api.post(base + "/campaigns", headers=owner,
                       json={"name": "Analytics", "kind": "fixed", "value": 50, "max_uses": 2})
    assert created.status_code == 201, created.text
    order, _ = buy(api, shop, promo_code=created.json()["code"])
    assert refund(api, shop, order).status_code == 200
    with db_engine.begin() as connection:
        connection.execute(text("UPDATE orders SET completed_at='2026-11-19 23:58:00+00' WHERE id=:id"),
                           {"id": order["id"]})
    response = api.get(base + "/analytics", headers=owner,
                       params={"date_from": "2026-11-19", "date_to": "2026-11-19",
                               "ticket_type_id": shop["paid"]})
    assert response.status_code == 200, response.text
    report = response.json()
    assert (report["sold"], report["remaining"], report["checked_in"], report["absent"]) == (0, 1, 0, 0)
    assert (report["gross_before_discount_tiyn"], report["discounts_tiyn"], report["refunds_tiyn"],
            report["net_sales_tiyn"]) == (10050, 50, 10000, 0)
    assert report["daily"][0]["date"] == "2026-11-19"
    assert len(report["daily"]) == 1
    assert api.get(base + "/analytics", headers=shop["buyer"].headers).status_code == 404


def test_public_demo_checkout_qr_and_staff_admission(api, paid_shop, register):
    shop = paid_shop
    owner, buyer, staff = shop["owner"], shop["buyer"], register()
    root = f"/events/{shop['eid']}"
    assert api.get(root).json()["visibility"] == "public"
    assert api.post(root + "/staff", headers=owner.headers, json={"email": staff.email}).status_code == 201
    campaign = api.post(root + "/campaigns", headers=owner.headers,
                        json={"name": "Admission", "kind": "fixed", "value": 50, "max_uses": 1})
    assert campaign.status_code == 201
    order, ticket = buy(api, shop, promo_code=campaign.json()["code"])
    assert order["total_tiyn"] == 10000
    pdf = api.get(f"/tickets/{ticket['id']}/pdf", headers=buyer.headers)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    def scan():
        return api.post(root + "/check-in", headers=staff.headers,
                        json={"request_id": str(uuid4()), "qr_payload": ticket["qr_payload"]})
    assert scan().status_code == 200
    duplicate = scan()
    assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "ALREADY_CHECKED_IN"
    summary = api.get(root + "/analytics", headers=owner.headers).json()
    assert (summary["sold"], summary["checked_in"], summary["net_sales_tiyn"]) == (1, 1, 10000)
