"""Input PostgreSQL itself refuses must come back as a client error, never a 500 the scanner would retry."""
import uuid


def test_nul_in_qr_is_an_invalid_ticket(api, register, published_event):
    owner = register("organizer")
    event = published_event(owner)
    response = api.post(
        f"/events/{event['id']}/check-in",
        json={"qr_payload": "bad\x00qr", "request_id": str(uuid.uuid4())},
        headers=owner.headers,
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "INVALID_TICKET"


def test_nul_in_stored_text_is_422(api, register):
    owner = register("organizer")
    event = {"title": "bad\x00title", "date": "2030-01-01T00:00:00Z", "location": "Hall", "capacity": 5}
    response = api.post("/events", json=event, headers=owner.headers)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "INVALID_INPUT"

    email = f"nul-{uuid.uuid4().hex[:8]}@example.com"
    account = {"email": email, "full_name": "bad\x00name", "password": "S3cret-Passw0rd"}
    assert api.post("/auth/register", json=account).status_code == 422


def test_ids_beyond_the_integer_range_are_422(api, register):
    user = register()
    for path in ("/events/99999999999", "/tickets/99999999999"):
        assert api.get(path, headers=user.headers).status_code == 422, path


def test_date_outside_the_utc_range_is_422(api, register):
    owner = register("organizer")
    event = {"title": "Edge event", "date": "0001-01-01T00:00:00+01:00", "location": "Hall", "capacity": 5}
    assert api.post("/events", json=event, headers=owner.headers).status_code == 422
