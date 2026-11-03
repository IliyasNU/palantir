"""Interleavings forced inside a running check-in (in-process app, real PostgreSQL, live API for the other side)."""
import threading
import time
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import event as sa_event

from app.db.session import engine
from app.main import app
from e2e.conftest import BASE_URL


def test_cancel_then_assign_during_a_scan_never_admits(api, register, published_event, sql):
    """Review round 5: the scan once read `published`, then saw an assignment made only after the cancel."""
    owner, attendee, newcomer = register("organizer"), register(), register()
    event = published_event(owner)
    ticket = api.post(f"/events/{event['id']}/tickets", headers=attendee.headers).json()
    results = {}

    def cancel_then_assign():
        import httpx

        with httpx.Client(base_url=BASE_URL, timeout=30) as other:
            results["cancel"] = other.post(f"/events/{event['id']}/cancel", headers=owner.headers).status_code
            results["assign"] = other.post(
                f"/events/{event['id']}/staff", json={"email": newcomer.email}, headers=owner.headers
            ).status_code

    mutation = threading.Thread(target=cancel_then_assign)

    def pause_before_access_check(conn, cursor, statement, parameters, context, executemany):
        if "FROM event_staff" in statement and not mutation.is_alive() and "cancel" not in results:
            mutation.start()
            time.sleep(1.5)  # without the event lock both mutations commit inside this window

    sa_event.listen(engine, "before_cursor_execute", pause_before_access_check)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post(
                f"/events/{event['id']}/check-in",
                json={"qr_payload": ticket["qr_payload"], "request_id": str(uuid.uuid4())},
                headers=newcomer.headers,
            )
    finally:
        sa_event.remove(engine, "before_cursor_execute", pause_before_access_check)
    mutation.join(timeout=30)

    assert response.status_code == 403, response.text  # not staff yet: the cancel waited for this scan
    assert results == {"cancel": 200, "assign": 201}
    assert sql("SELECT count(*) FROM check_ins WHERE event_id = :id", id=event["id"]) == 0
