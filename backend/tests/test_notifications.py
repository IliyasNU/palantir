"""BE-3a notifications and BE-3b ticket and event emails."""
import pytest
from sqlalchemy import select

from app import email, notifications
from app.models import Notification, User


@pytest.fixture()
def outbox(monkeypatch):
    sent = []
    monkeypatch.setattr(
        email, "send_email",
        lambda to, subject, body, attachment=None: sent.append(
            {"to": to, "subject": subject, "body": body, "attachment": attachment}
        ),
    )
    return sent


@pytest.fixture()
def event_with_holder(client, login_as, new_event):
    _, organizer = login_as("org@example.com", role="organizer")
    event = new_event(organizer, title="Demo Day", location="Hall A")
    _, attendee = login_as("fan@example.com")
    claimed = client.post(f"/events/{event['id']}/tickets", headers=attendee)
    assert claimed.status_code == 201, claimed.text
    return event, organizer, attendee, claimed.json()


def kinds(client, headers):
    return [item["kind"] for item in client.get("/notifications/me", headers=headers).json()]


# ------------------------------------------------------------------ ticket email
def test_a_free_claim_emails_the_ticket_pdf_once(client, outbox, event_with_holder):
    event, _, attendee, ticket = event_with_holder
    [sent] = outbox
    assert sent["to"] == "fan@example.com"
    assert "Demo Day" in sent["subject"] and "Hall A" in sent["body"]
    filename, pdf = sent["attachment"]
    assert filename == f"biletflow-ticket-{ticket['id']}.pdf" and pdf.startswith(b"%PDF")

    [item] = client.get("/notifications/me", headers=attendee).json()
    assert (item["kind"], item["link"], item["read_at"]) == ("ticket.issued", f"/tickets/{ticket['id']}", None)

    # A repeated claim returns the same ticket and sends nothing.
    again = client.post(f"/events/{event['id']}/tickets", headers=attendee)
    assert again.status_code == 200 and again.json()["id"] == ticket["id"]
    assert len(outbox) == 1 and kinds(client, attendee) == ["ticket.issued"]


def test_a_mail_failure_never_fails_the_claim(client, monkeypatch, login_as, new_event):
    def broken(*args, **kwargs):
        raise RuntimeError("mail server down")

    monkeypatch.setattr(email, "send_email", broken)
    _, organizer = login_as("org@example.com", role="organizer")
    event = new_event(organizer)
    _, attendee = login_as("fan@example.com")
    assert client.post(f"/events/{event['id']}/tickets", headers=attendee).status_code == 201
    assert kinds(client, attendee) == ["ticket.issued"]  # the in-app copy is kept


def test_email_goes_out_only_after_commit(db, outbox, create_user):
    user = create_user("someone@example.com")
    notifications.notify(db, user, "test", "Rolled back", "body")
    db.rollback()
    assert outbox == [] and db.scalars(select(Notification)).all() == []

    notifications.notify(db, user, "test", "Kept", "body")
    assert outbox == []
    db.commit()
    assert [sent["subject"] for sent in outbox] == ["Kept"]


# ------------------------------------------------------------------ event emails
def test_holders_hear_about_new_time_place_or_name_only(client, outbox, event_with_holder, login_as):
    event, organizer, attendee, _ = event_with_holder
    _, other = login_as("other@example.com")
    client.post(f"/events/{event['id']}/tickets", headers=other)
    ticket = client.get("/tickets/me", headers=other).json()[0]
    assert client.post(f"/tickets/{ticket['id']}/cancel", headers=other).status_code == 200
    outbox.clear()

    client.patch(f"/events/{event['id']}", json={"description": "New text", "capacity": 200}, headers=organizer)
    client.patch(f"/events/{event['id']}", json={"location": "Hall A"}, headers=organizer)  # unchanged
    assert outbox == []

    response = client.patch(f"/events/{event['id']}", json={"location": "Hall B"}, headers=organizer)
    assert response.status_code == 200
    [sent] = outbox  # the holder whose ticket was cancelled is not told
    assert sent["to"] == "fan@example.com" and "Новое место: Hall B" in sent["body"]
    assert kinds(client, attendee) == ["event.updated", "ticket.issued"]
    assert kinds(client, other) == ["ticket.issued"]


def test_cancelling_tells_each_holder_once(client, outbox, event_with_holder):
    event, organizer, attendee, _ = event_with_holder
    outbox.clear()
    for _ in range(2):
        assert client.post(f"/events/{event['id']}/cancel", headers=organizer).status_code == 200
    [sent] = outbox
    assert sent["to"] == "fan@example.com" and "отменено" in sent["subject"]
    assert kinds(client, attendee) == ["event.cancelled", "ticket.issued"]


def test_drafts_send_nothing(client, outbox, login_as, new_event):
    _, organizer = login_as("org@example.com", role="organizer")
    draft = new_event(organizer, publish=False)
    client.patch(f"/events/{draft['id']}", json={"location": "Elsewhere"}, headers=organizer)
    client.post(f"/events/{draft['id']}/cancel", headers=organizer)
    assert outbox == []


# ------------------------------------------------------------------ notifications API
def test_list_and_mark_read(client, outbox, event_with_holder, db):
    event, organizer, attendee, _ = event_with_holder
    client.post(f"/events/{event['id']}/cancel", headers=organizer)
    newest, oldest = client.get("/notifications/me", headers=attendee).json()
    assert (newest["kind"], oldest["kind"]) == ("event.cancelled", "ticket.issued")

    assert client.post(f"/notifications/{oldest['id']}/read", headers=organizer).status_code == 404
    assert client.post("/notifications/999999/read", headers=attendee).status_code == 404
    first = client.post(f"/notifications/{oldest['id']}/read", headers=attendee).json()
    assert first["read_at"] is not None
    assert client.post(f"/notifications/{oldest['id']}/read", headers=attendee).json()["read_at"] == first["read_at"]

    unread = client.get("/notifications/me", params={"unread": "true"}, headers=attendee).json()
    assert [item["id"] for item in unread] == [newest["id"]]
    assert client.get("/notifications/me", headers=organizer).json() == []
    assert client.get("/notifications/me").status_code == 401


def test_deleting_a_user_deletes_their_notifications(db, outbox, create_user):
    user = create_user("gone@example.com")
    notifications.notify(db, user, "test", "Hi", "body")
    db.commit()
    db.delete(db.get(User, user.id))
    db.commit()
    assert db.scalars(select(Notification)).all() == []
