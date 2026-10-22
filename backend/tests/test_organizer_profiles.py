import pytest

from tests.helpers import profile_payload


def make_organizer(create_user, auth_header, email="org@example.com"):
    user = create_user(email, role="organizer")
    return user, auth_header(email)


def test_organizer_can_create_profile(client, create_user, auth_header):
    user, headers = make_organizer(create_user, auth_header)
    payload = profile_payload()
    response = client.post("/organizer-profiles", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["user_id"] == user.id
    assert body["organization_name"] == payload["organization_name"]
    assert body["contact_email"] == payload["contact_email"]
    assert body["contact_phone"] == payload["contact_phone"]
    assert body["website"] == payload["website"]


def test_second_profile_for_same_organizer_is_a_conflict(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    assert client.post("/organizer-profiles", json=profile_payload(), headers=headers).status_code == 201
    assert client.post("/organizer-profiles", json=profile_payload(), headers=headers).status_code == 409


def test_attendee_cannot_create_profile(client, create_user, auth_header):
    create_user("att@example.com", role="attendee")
    response = client.post("/organizer-profiles", json=profile_payload(), headers=auth_header("att@example.com"))
    assert response.status_code == 403


def test_anonymous_cannot_create_profile(client):
    assert client.post("/organizer-profiles", json=profile_payload()).status_code == 401


def test_view_my_profile(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    assert client.get("/organizer-profiles/me", headers=headers).status_code == 404  # none yet
    client.post("/organizer-profiles", json=profile_payload(), headers=headers)
    response = client.get("/organizer-profiles/me", headers=headers)
    assert response.status_code == 200
    assert response.json()["organization_name"] == "NU Robotics Club"


@pytest.mark.parametrize("method", ["put", "patch"])
def test_update_my_profile_changes_only_sent_fields(client, create_user, auth_header, method):
    _, headers = make_organizer(create_user, auth_header)
    client.post("/organizer-profiles", json=profile_payload(), headers=headers)
    response = client.request(
        method.upper(), "/organizer-profiles/me", json={"organization_name": "Renamed Club"}, headers=headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["organization_name"] == "Renamed Club"
    assert body["description"] == "Student robotics community"  # untouched


def test_update_can_clear_optional_fields_with_null(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    client.post("/organizer-profiles", json=profile_payload(), headers=headers)
    response = client.patch("/organizer-profiles/me", json={"contact_phone": None}, headers=headers)
    assert response.status_code == 200
    assert response.json()["contact_phone"] is None


def test_update_cannot_null_the_organization_name(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    client.post("/organizer-profiles", json=profile_payload(), headers=headers)
    response = client.patch("/organizer-profiles/me", json={"organization_name": None}, headers=headers)
    assert response.status_code == 422


def test_update_without_profile_is_404(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    assert client.put("/organizer-profiles/me", json={"organization_name": "X Club"}, headers=headers).status_code == 404


def test_blank_optional_fields_are_stored_as_null(client, create_user, auth_header):
    _, headers = make_organizer(create_user, auth_header)
    payload = {"organization_name": "Blank Club", "contact_email": "", "website": "   ", "description": ""}
    response = client.post("/organizer-profiles", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["contact_email"] is None
    assert body["website"] is None
    assert body["description"] is None


@pytest.mark.parametrize(
    "bad",
    [
        {"organization_name": ""},
        {"organization_name": "A"},
        {"contact_email": "nope"},
        {"contact_phone": "abc"},
        {"website": "ftp://example.com"},
    ],
)
def test_invalid_profile_data_is_rejected(client, create_user, auth_header, bad):
    _, headers = make_organizer(create_user, auth_header)
    response = client.post("/organizer-profiles", json=profile_payload(**bad), headers=headers)
    assert response.status_code == 422


def test_any_logged_in_user_can_view_a_profile_by_id(client, create_user, auth_header):
    _, org_headers = make_organizer(create_user, auth_header)
    profile_id = client.post("/organizer-profiles", json=profile_payload(), headers=org_headers).json()["id"]
    create_user("att@example.com", role="attendee")
    att_headers = auth_header("att@example.com")

    assert client.get(f"/organizer-profiles/{profile_id}", headers=att_headers).status_code == 200
    assert client.get(f"/organizer-profiles/{profile_id}").status_code == 401
    assert client.get("/organizer-profiles/99999", headers=att_headers).status_code == 404
