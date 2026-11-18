"""Real HTTP and PostgreSQL reservation races. Counts always equal active tickets + pending orders."""
from uuid import uuid4

import pytest
from sqlalchemy import text

from e2e.conftest import run_concurrently


@pytest.fixture()
def paid_shop(api, register, published_event):
    owner = register("organizer")
    buyer = register()
    event = published_event(owner, capacity=2)
    eid = event["id"]
    free = event["ticket_types"][0]["id"]
    assert api.patch(f"/events/{eid}/ticket-types/{free}", headers=owner.headers, json={"quantity": 1}).status_code == 200
    result = api.post(f"/events/{eid}/ticket-types", headers=owner.headers,
                      json={"name": "Paid race", "price_tiyn": 10050, "quantity": 1})
    assert result.status_code == 201, result.text
    paid = result.json()["id"]
    for route, body in (("/organizer-profiles", {"organization_name": "E2E Demo"}),
                        ("/organizer-profiles/me/confirm-identity", None),
                        ("/organizer-profiles/me/payout-details", {"reference_last4": "TEST"}),
                        (f"/events/{eid}/activation/terms", None), (f"/events/{eid}/activation/fee", None)):
        result = api.post(route, headers=owner.headers, json=body)
        assert result.status_code in (200, 201), result.text
    assert result.json()["activated"]
    def body(key=None):
        return {"ticket_type_id": paid, "attendee_name": "Race Buyer", "attendee_email": buyer.email,
                "request_id": str(key or uuid4())}
    return dict(owner=owner, buyer=buyer, eid=eid, free=free, paid=paid, body=body)


def assert_counts(sql, eid):
    active = sql("SELECT count(*) FROM tickets WHERE event_id=:id AND status='active'", id=eid)
    pending = sql("SELECT count(*) FROM orders WHERE event_id=:id AND status='pending'", id=eid)
    assert sql("SELECT tickets_issued FROM events WHERE id=:id", id=eid) == active + pending
    assert sql("SELECT count(*) FROM ticket_types tt WHERE tt.event_id=:id AND tt.tickets_issued <> "
               "(SELECT count(*) FROM tickets t WHERE t.ticket_type_id=tt.id AND t.status='active') + "
               "(SELECT count(*) FROM orders o WHERE o.ticket_type_id=tt.id AND o.status='pending')", id=eid) == 0
    assert sql("SELECT count(*) FROM orders WHERE event_id=:id AND ((status='paid') <> (ticket_id IS NOT NULL))", id=eid) == 0


def test_two_buyers_race_last_paid_seat(api, register, paid_shop, sql):
    s = paid_shop
    other = register()
    responses = run_concurrently([
        lambda c: c.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=s["body"]()),
        lambda c: c.post(f"/events/{s['eid']}/orders", headers=other.headers, json=s["body"]()),
    ])
    assert sorted(r.status_code for r in responses) == [201, 409]
    assert_counts(sql, s["eid"])


@pytest.mark.parametrize("same_key", [False, True])
def test_two_parallel_checkout_same_buyer(paid_shop, sql, same_key):
    s = paid_shop
    body1 = s["body"]()
    body2 = body1 if same_key else s["body"]()
    responses = run_concurrently([
        lambda c, body=body: c.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=body)
        for body in (body1, body2)
    ])
    assert sorted(r.status_code for r in responses) == ([200, 201] if same_key else [201, 409])
    assert sql("SELECT count(*) FROM orders WHERE event_id=:id", id=s["eid"]) == 1
    if not same_key:
        assert next(r for r in responses if r.status_code == 409).json()["detail"]["code"] == "PENDING_ORDER_EXISTS"
    assert_counts(sql, s["eid"])


def test_free_claim_races_checkout_same_buyer(paid_shop, sql):
    s = paid_shop
    responses = run_concurrently([
        lambda c: c.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=s["body"]()),
        lambda c: c.post(f"/events/{s['eid']}/tickets", headers=s["buyer"].headers, json={"ticket_type_id": s["free"]}),
    ])
    assert sorted(r.status_code for r in responses) == [201, 409]
    assert next(r for r in responses if r.status_code == 409).json()["detail"]["code"] in ("PENDING_ORDER_EXISTS", "ACTIVE_TICKET_EXISTS")
    assert_counts(sql, s["eid"])


@pytest.mark.parametrize("expired", [False, True])
def test_payment_races_expiry_and_repeats(api, paid_shop, sql, db_engine, expired):
    s = paid_shop
    result = api.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=s["body"]())
    assert result.status_code == 201, result.text
    oid = result.json()["id"]
    if expired:
        with db_engine.begin() as db:
            db.execute(text("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=:id"), {"id": oid})
    responses = run_concurrently([
        lambda c: c.post(f"/orders/{oid}/pay", headers=s["buyer"].headers, json={"outcome": "success"}),
        lambda c: c.get(f"/orders/{oid}", headers=s["buyer"].headers),
        lambda c: c.get(f"/events/{s['eid']}"),
        lambda c: c.post(f"/orders/{oid}/pay", headers=s["buyer"].headers, json={"outcome": "success"}),
    ])
    assert responses[0].status_code == responses[3].status_code == (409 if expired else 200)
    expected = "expired" if expired else "paid"
    assert sql("SELECT status FROM orders WHERE id=:id", id=oid) == expected
    assert sql("SELECT count(*) FROM tickets WHERE event_id=:id", id=s["eid"]) == (0 if expired else 1)
    for _ in range(2):
        assert api.get(f"/orders/{oid}", headers=s["buyer"].headers).json()["status"] == expected
    assert_counts(sql, s["eid"])


def test_event_suspension_races_payment(api, paid_shop, register, db_engine, sql):
    s = paid_shop
    admin = register()
    with db_engine.begin() as db:
        db.execute(text("UPDATE users SET role_id=(SELECT id FROM roles WHERE name='admin') WHERE id=:id"), {"id": admin.id})
    oid = api.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=s["body"]()).json()["id"]
    results = run_concurrently([
        lambda c: c.post(f"/orders/{oid}/pay", headers=s["buyer"].headers, json={"outcome": "success"}),
        lambda c: c.post(f"/admin/events/{s['eid']}/suspend", headers=admin.headers, json={"reason": "E2E suspension"}),
    ])
    assert results[1].status_code == 200
    assert results[0].status_code in (200, 409)
    assert sql("SELECT count(*) FROM tickets t JOIN events e ON e.id=t.event_id WHERE e.id=:id AND t.created_at>e.suspended_at", id=s["eid"]) == 0
    assert_counts(sql, s["eid"])


def test_mixed_buyers_race_remaining_event_capacity(api, paid_shop, register, sql):
    s = paid_shop
    # Occupy the free allocation first; only the paid seat remains.
    occupant = register()
    assert api.post(f"/events/{s['eid']}/tickets", headers=occupant.headers, json={"ticket_type_id": s["free"]}).status_code == 201
    other = register()
    results = run_concurrently([
        lambda c: c.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=s["body"]()),
        lambda c: c.post(f"/events/{s['eid']}/tickets", headers=other.headers, json={"ticket_type_id": s["free"]}),
    ])
    assert results[0].status_code == 201 and results[1].status_code == 409
    assert_counts(sql, s["eid"])


def test_paid_ticket_uses_existing_pdf_and_check_in(api, paid_shop, sql):
    s = paid_shop
    oid = api.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=s["body"]()).json()["id"]
    result = api.post(f"/orders/{oid}/pay", headers=s["buyer"].headers, json={"outcome": "success"})
    assert result.status_code == 200, result.text
    tid = result.json()["ticket_id"]
    ticket = api.get(f"/tickets/{tid}", headers=s["buyer"].headers).json()
    pdf = api.get(f"/tickets/{tid}/pdf", headers=s["buyer"].headers)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    check_in = api.post(f"/events/{s['eid']}/check-in", headers=s["owner"].headers,
                        json={"qr_payload": ticket["qr_payload"], "request_id": str(uuid4())})
    assert check_in.status_code == 200, check_in.text
    assert_counts(sql, s["eid"])


def test_expiry_command_releases_once(api, paid_shop, db_engine, sql):
    from scripts.expire_orders import main
    s = paid_shop
    oid = api.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=s["body"]()).json()["id"]
    with db_engine.begin() as db:
        db.execute(text("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=:id"), {"id": oid})
    main()
    main()
    assert sql("SELECT status FROM orders WHERE id=:id", id=oid) == "expired"
    assert_counts(sql, s["eid"])


def test_confirmation_waiting_for_event_lock_rechecks_expiry(api, paid_shop, db_engine, sql):
    import time
    from concurrent.futures import ThreadPoolExecutor
    import httpx
    from e2e.conftest import BASE_URL
    s = paid_shop
    oid = api.post(f"/events/{s['eid']}/orders", headers=s["buyer"].headers, json=s["body"]()).json()["id"]
    def confirm():
        return httpx.post(f"{BASE_URL}/orders/{oid}/pay", headers=s["buyer"].headers,
                          json={"outcome": "success"}, timeout=30)
    with ThreadPoolExecutor(max_workers=2) as pool:
        with db_engine.begin() as holder:
            holder.execute(text("SELECT id FROM events WHERE id=:id FOR UPDATE"), {"id": s["eid"]})
            first, second = pool.submit(confirm), pool.submit(confirm)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' "
                       "AND query LIKE '%FROM events%'") >= 2:
                    break
                time.sleep(.02)
            else:
                pytest.fail("Both confirmations must wait for the held event lock")
            holder.execute(text("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=:id"), {"id": oid})
        results = [first.result(), second.result()]
    assert all(r.status_code == 409 and r.json()["detail"]["code"] == "ORDER_EXPIRED" for r in results)
    assert sql("SELECT count(*) FROM tickets WHERE event_id=:id", id=s["eid"]) == 0
    assert_counts(sql, s["eid"])
