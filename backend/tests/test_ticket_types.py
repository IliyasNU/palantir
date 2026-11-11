from app.models import ActionLog
from sqlalchemy import select


def test_manage_types_audit_and_visitor_visibility(client, db, login_as, new_event):
    owner, manager = login_as("p1-owner@example.com", "organizer")
    _, visitor = login_as("p1-visitor@example.com")
    event = new_event(manager, capacity=6)
    root = f"/events/{event['id']}"
    path = f"{root}/ticket-types"
    default = event["ticket_types"][0]
    assert (default["price_tiyn"], default["quantity"]) == (0, 6)
    assert client.get(f"{path}/manage", headers=visitor).status_code == 403
    assert client.post(path, json={"name": "Балкон", "quantity": 1}, headers=manager).json()["detail"]["code"] == "TICKET_TYPES_CAPACITY"
    assert client.patch(f"{path}/{default['id']}", json={"quantity": 4}, headers=manager).status_code == 200
    created = client.post(path, json={"name": "Балкон", "quantity": 2, "price_tiyn": 12345}, headers=manager)
    assert created.status_code == 201, created.text
    type_id = created.json()["id"]
    paid = client.post(f"{root}/tickets", json={"ticket_type_id": type_id}, headers=visitor)
    assert paid.status_code == 409 and paid.json()["detail"]["code"] == "PAID_TICKETS_NOT_SUPPORTED"
    assert client.patch(f"{path}/{type_id}", json={"hidden": True, "quantity": 1, "price_tiyn": 800}, headers=manager).status_code == 200
    assert [row["id"] for row in client.get(path).json()] == [default["id"]]
    assert [row["id"] for row in client.get(root).json()["ticket_types"]] == [default["id"]]
    assert client.get(f"{path}/manage", headers=manager).json()[1]["hidden"] is True
    assert client.get(f"{root}/action-log", headers=visitor).status_code == 403
    entries = client.get(f"{root}/action-log", headers=manager).json()
    assert len(entries) == 4
    assert all(row["actor_id"] == owner.id for row in entries)
    assert entries[0]["action"] == "ticket_type.updated" and entries[0]["entity_id"] == type_id
    assert all(field in entries[0]["description"] for field in ("price_tiyn", "quantity", "hidden"))
    assert client.delete(f"{root}/action-log", headers=manager).status_code == 405
    assert len(db.scalars(select(ActionLog).where(ActionLog.event_id == event["id"])).all()) == 4


def test_claim_respects_type_selection_event_and_window(client, login_as, new_event):
    _, manager = login_as("p1-manager@example.com", "organizer")
    _, visitor = login_as("p1-buyer@example.com")
    event = new_event(manager, capacity=4)
    other = new_event(manager)
    root = f"/events/{event['id']}"
    path = f"{root}/ticket-types"
    default = event["ticket_types"][0]
    assert client.patch(f"{path}/{default['id']}", json={"quantity": 2}, headers=manager).status_code == 200
    future = client.post(path, json={
        "name": "Позже", "quantity": 2, "sales_start": "2090-01-01T00:00:00Z",
        "sales_end": "2090-01-02T00:00:00Z", "order_limit": 3,
    }, headers=manager).json()
    claim_url = f"{root}/tickets"
    assert client.post(claim_url, headers=visitor).json()["detail"]["code"] == "TICKET_TYPE_REQUIRED"
    for type_id, code in [
        (other["ticket_types"][0]["id"], "TICKET_TYPE_NOT_FOUND"),
        (future["id"], "TICKET_TYPE_SALES_NOT_STARTED"),
    ]:
        assert client.post(claim_url, json={"ticket_type_id": type_id}, headers=visitor).json()["detail"]["code"] == code
    claim = client.post(claim_url, json={"ticket_type_id": default["id"]}, headers=visitor)
    assert claim.status_code == 201, claim.text
    assert claim.json()["ticket_type_id"] == default["id"]
    assert client.get(root).json()["tickets_issued"] == 1
    assert client.get(path).json()[0]["remaining"] == 1
    assert client.patch(f"{path}/{default['id']}", json={"quantity": 0}, headers=manager).json()["detail"]["code"] == "TICKET_TYPE_BELOW_ISSUED"
    assert client.patch(root, json={"capacity": 3}, headers=manager).json()["detail"]["code"] == "TICKET_TYPES_CAPACITY"
