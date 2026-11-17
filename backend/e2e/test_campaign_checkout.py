import pytest
from sqlalchemy import text
from alembic import command
from e2e.conftest import run_concurrently
from e2e.test_orders import paid_shop, assert_counts  # noqa: F401
from e2e.test_postgres_schema import scratch_database, alembic_config  # noqa: F401
from sqlalchemy import create_engine


def test_last_redemption_is_reserved_once_and_reusable_after_expiry(api, register, sql, db_engine, paid_shop):
    s = paid_shop
    eid = s["eid"]
    api.patch(f"/events/{eid}/ticket-types/{s['free']}", headers=s["owner"].headers, json={"quantity": 0})
    assert api.patch(f"/events/{eid}/ticket-types/{s['paid']}", headers=s["owner"].headers,
                     json={"quantity": 2}).status_code == 200
    campaign = api.post(f"/events/{eid}/campaigns", headers=s["owner"].headers,
                        json={"name": "Last use", "kind": "fixed", "value": 50, "max_uses": 1}).json()
    buyers = [s["buyer"], register()]
    bodies = [s["body"]() | {"promo_code": campaign["code"]} for _ in buyers]
    def attempt(i):
        return lambda c: c.post(f"/events/{eid}/orders", headers=buyers[i].headers, json=bodies[i])
    responses = run_concurrently([attempt(0), attempt(1)])
    assert sorted(r.status_code for r in responses) == [201, 409]
    first = next(i for i, r in enumerate(responses) if r.status_code == 201)
    assert responses[1-first].json()["detail"]["code"] == "PROMO_EXHAUSTED"
    expired = responses[first].json()["id"]
    with db_engine.begin() as db:
        db.execute(text("UPDATE orders SET expires_at = now() - interval '1 second' WHERE id=:id"), {"id": expired})
    second = attempt(1-first)(api)
    assert second.status_code == 201, second.text
    oid = second.json()["id"]
    for _ in range(2):
        paid = api.post(f"/orders/{oid}/pay", headers=buyers[1-first].headers, json={"outcome": "success"})
        assert paid.status_code == 200 and paid.json()["total_tiyn"] == 10000
    assert api.post(f"/orders/{expired}/pay", headers=buyers[first].headers,
                    json={"outcome": "success"}).json()["detail"]["code"] == "ORDER_EXPIRED"
    report = api.get(f"/events/{eid}/campaigns", headers=s["owner"].headers).json()[0]
    assert (report["orders"], report["redemptions"], report["tickets_sold"], report["organizer_net_tiyn"]) == (2, 1, 1, 9700)
    assert_counts(sql, eid)


def test_campaign_downgrade_guard(scratch_database):
    config = alembic_config(scratch_database)
    command.upgrade(config, "head")
    engine = create_engine(scratch_database)
    try:
        with engine.begin() as db:
            user = db.execute(text("INSERT INTO users (email, full_name, hashed_password, role_id) "
                                   "SELECT 'p3@example.com','Demo','test',id FROM roles WHERE name='organizer' RETURNING id")).scalar_one()
            eid = db.execute(text("INSERT INTO events (organizer_id,title,date,location,capacity,tickets_issued,status) "
                                  "VALUES (:u,'Demo',now(),'Hall',2,0,'published') RETURNING id"), {"u": user}).scalar_one()
            db.execute(text("INSERT INTO campaigns(event_id,name,code,token,kind,value,max_uses,enabled) "
                            "VALUES (:e,'Demo','ABC','opaque','percent',5,1,true)"), {"e": eid})
        with pytest.raises(RuntimeError, match="campaign data"):
            command.downgrade(config, "0006")
    finally:
        engine.dispose()
