"""Exercise inventory writers over HTTP with a real PostgreSQL database."""
from e2e.conftest import run_concurrently
from e2e.test_concurrency import codes


def test_last_seat_of_one_type_does_not_consume_other_types(api, register, published_event, sql):
    owner = register("organizer")
    event_id = published_event(owner, capacity=4)["id"]
    path = f"/events/{event_id}/ticket-types"
    default = api.get(path).json()[0]
    resized = api.patch(f"{path}/{default['id']}", json={"quantity": 3}, headers=owner.headers)
    assert resized.status_code == 200, resized.text
    created = api.post(path, json={"name": "Балкон", "quantity": 1}, headers=owner.headers)
    assert created.status_code == 201, created.text
    type_id = created.json()["id"]
    attendees = [register() for _ in range(6)]

    def claim(client, attendee, selected):
        return client.post(f"/events/{event_id}/tickets",
                           json={"ticket_type_id": selected}, headers=attendee.headers)

    results = run_concurrently([lambda client, attendee=a: claim(client, attendee, type_id) for a in attendees])
    assert codes(results) == {201: 1, "TICKET_TYPE_SOLD_OUT": 5}
    winner = next(index for index, result in enumerate(results) if result.status_code == 201)
    loser = next(index for index, result in enumerate(results) if result.status_code == 409)
    ticket = results[winner].json()
    assert ticket["ticket_type"] == {"id": type_id, "name": "Балкон", "price_tiyn": 0}
    assert sql("SELECT tickets_issued FROM events WHERE id = :id", id=event_id) == 1
    assert sql("SELECT tickets_issued FROM ticket_types WHERE id = :id", id=type_id) == 1
    assert sql("SELECT count(*) FROM tickets WHERE ticket_type_id = :id", id=type_id) == 1
    replay = claim(api, attendees[winner], default["id"])
    assert replay.status_code == 200 and replay.json()["id"] == ticket["id"]
    assert claim(api, attendees[loser], default["id"]).status_code == 201
    closed = api.post(f"/tickets/{ticket['id']}/cancel", headers=attendees[winner].headers)
    assert closed.status_code == 200
    assert sql("SELECT tickets_issued FROM ticket_types WHERE id = :id", id=type_id) == 0
    assert sql("SELECT tickets_issued FROM events WHERE id = :id", id=event_id) == 1


def test_concurrent_allocations_cannot_exceed_event_capacity(api, register, published_event, sql):
    owner = register("organizer")
    event_id = published_event(owner, capacity=3)["id"]
    path = f"/events/{event_id}/ticket-types"
    type_id = api.get(path).json()[0]["id"]
    assert api.patch(f"{path}/{type_id}", json={"quantity": 1}, headers=owner.headers).status_code == 200
    results = run_concurrently([
        lambda client, name=name: client.post(path, json={"name": name, "quantity": 2}, headers=owner.headers)
        for name in ("A", "B")
    ])
    assert codes(results) == {201: 1, "TICKET_TYPES_CAPACITY": 1}
    assert sql("SELECT sum(quantity) FROM ticket_types WHERE event_id = :id", id=event_id) == 3
