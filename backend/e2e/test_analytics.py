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
