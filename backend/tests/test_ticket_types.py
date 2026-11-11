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


def test_ticket_type_validation_uses_existing_422_shapes(client, login_as, new_event):
    _, manager = login_as("p1-validation@example.com", "organizer")
    event = new_event(manager)
    path = f"/events/{event['id']}/ticket-types"

    price = client.post(path, json={"name": "Партер", "quantity": 1, "price_tiyn": 12.5}, headers=manager)
    assert price.status_code == 422
    assert [error["loc"] for error in price.json()["detail"]] == [["body", "price_tiyn"]]

    type_path = f"{path}/{event['ticket_types'][0]['id']}"
    starts = client.patch(type_path, json={"sales_start": "2090-01-02T00:00:00Z"}, headers=manager)
    assert starts.status_code == 200
    ends = client.patch(type_path, json={"sales_end": "2090-01-01T00:00:00Z"}, headers=manager)
    assert ends.status_code == 422
    assert ends.json()["detail"]["code"] == "INVALID_INPUT"


def test_other_event_type_cannot_be_created_edited_or_hidden_under_this_event(client, login_as, new_event):
    _, manager = login_as("p1-host@example.com", "organizer")
    _, other_manager = login_as("p1-other-host@example.com", "organizer")
    event = new_event(manager)
    other = new_event(other_manager)
    other_type = other["ticket_types"][0]
    path = f"/events/{event['id']}/ticket-types"

    created = client.post(path, json={"event_id": other["id"], "name": "Партер", "quantity": 0}, headers=manager)
    assert created.status_code == 404
    assert created.json()["detail"]["code"] == "EVENT_NOT_FOUND"
    for change in ({"name": "Партер"}, {"hidden": True}):
        changed = client.patch(f"{path}/{other_type['id']}", json=change, headers=manager)
        assert changed.status_code == 404
        assert changed.json()["detail"]["code"] == "TICKET_TYPE_NOT_FOUND"
    assert client.get(path).json() == event["ticket_types"]
    assert client.get(f"/events/{other['id']}/ticket-types").json() == [other_type]
    matching = client.post(path, json={"event_id": event["id"], "name": "Партер", "quantity": 0}, headers=manager)
    assert matching.status_code == 201
    assert matching.json()["event_id"] == event["id"]


def test_foreign_type_is_not_found_on_full_event_or_ticket_replay(client, login_as, new_event):
    _, manager = login_as("p1-capacity-host@example.com", "organizer")
    _, visitor = login_as("p1-holder@example.com")
    _, second_visitor = login_as("p1-second-visitor@example.com")
    event = new_event(manager, capacity=1)
    other = new_event(manager)
    type_id = event["ticket_types"][0]["id"]
    other_type_id = other["ticket_types"][0]["id"]
    path = f"/events/{event['id']}/tickets"
    issued = client.post(path, json={"ticket_type_id": type_id}, headers=visitor)
    assert issued.status_code == 201
    for headers in (visitor, second_visitor):
        foreign = client.post(path, json={"ticket_type_id": other_type_id}, headers=headers)
        assert foreign.status_code == 404
        assert foreign.json()["detail"]["code"] == "TICKET_TYPE_NOT_FOUND"
    replay = client.post(path, json={"ticket_type_id": type_id}, headers=visitor)
    assert replay.status_code == 200
    assert replay.json()["id"] == issued.json()["id"]


def test_server_rejects_claims_before_and_after_the_sales_window(client, login_as, new_event):
    _, manager = login_as("p1-sales-host@example.com", "organizer")
    _, visitor = login_as("p1-sales-visitor@example.com")
    event = new_event(manager, capacity=1)
    event_path = f"/events/{event['id']}"
    type_id = event["ticket_types"][0]["id"]
    type_path = f"{event_path}/ticket-types/{type_id}"
    for window, expected_code in (
        ({"sales_start": "2090-01-01T00:00:00Z"}, "TICKET_TYPE_SALES_NOT_STARTED"),
        ({"sales_start": "2000-01-01T00:00:00Z", "sales_end": "2001-01-01T00:00:00Z"}, "TICKET_TYPE_SALES_ENDED"),
    ):
        assert client.patch(type_path, json=window, headers=manager).status_code == 200
        response = client.post(f"{event_path}/tickets", json={"ticket_type_id": type_id}, headers=visitor)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == expected_code
    updated = client.get(event_path).json()
    assert updated["tickets_issued"] == updated["ticket_types"][0]["tickets_issued"] == 0
