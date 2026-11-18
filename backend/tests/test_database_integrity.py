"""Database guarantees that API-only happy paths cannot prove."""
import uuid

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError

from app.db.base import utcnow
from app.models import CheckIn, Event, EventStaff, OrganizerProfile, Ticket, TicketType, User


@pytest.fixture()
def ticket_graph(db, create_user):
    owner = create_user("integrity-owner@example.com", role="organizer")
    attendee = create_user("integrity-attendee@example.com")
    staff = create_user("integrity-staff@example.com")
    event = Event(organizer_id=owner.id, title="Integrity event", date=utcnow(), location="Hall", capacity=10)
    db.add(event)
    db.flush()
    ticket_type = TicketType(event_id=event.id, name="Бесплатный", quantity=10, tickets_issued=2, is_default=True)
    db.add(ticket_type)
    db.flush()
    first = Ticket(event_id=event.id, attendee_id=attendee.id, ticket_type_id=ticket_type.id, qr_payload="integrity:first")
    second = Ticket(event_id=event.id, attendee_id=staff.id, ticket_type_id=ticket_type.id, qr_payload="integrity:second")
    db.add_all([first, second])
    db.commit()
    return event, attendee, staff, first, second


def test_foreign_keys_are_enabled_and_orphan_tickets_are_rejected(db, ticket_graph):
    event, attendee, _staff, first, _second = ticket_graph
    assert db.scalar(text("PRAGMA foreign_keys")) == 1
    for event_id, attendee_id in ((-1, attendee.id), (event.id, -1)):
        db.add(Ticket(event_id=event_id, attendee_id=attendee_id, ticket_type_id=first.ticket_type_id, qr_payload="integrity:orphan"))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


def test_ticket_references_restrict_parent_deletion(db, ticket_graph):
    event, attendee, _staff, first, _second = ticket_graph
    for parent, identifier in ((Event, event.id), (User, attendee.id)):
        with pytest.raises(IntegrityError):
            db.execute(delete(parent).where(parent.id == identifier))
            db.commit()
        db.rollback()
    assert db.get(Ticket, first.id) is not None


def test_deleting_unused_user_cascades_profile_and_staff_assignment(db, create_user):
    owner = create_user("cascade-owner@example.com", role="organizer")
    member = create_user("cascade-member@example.com", role="organizer")
    event = Event(organizer_id=owner.id, title="Cascade event", date=utcnow(), location="Hall", capacity=10)
    db.add(event)
    db.flush()
    db.add_all([
        OrganizerProfile(user_id=member.id, organization_name="Test organization"),
        EventStaff(event_id=event.id, user_id=member.id),
    ])
    db.commit()
    member_id, event_id = member.id, event.id
    # Core DELETE lets the database, rather than ORM relationship cascades, enforce this.
    db.execute(delete(User).where(User.id == member_id))
    db.commit()
    assert db.scalar(select(OrganizerProfile.id).where(OrganizerProfile.user_id == member_id)) is None
    assert db.scalar(select(EventStaff.user_id).where(EventStaff.user_id == member_id)) is None
    assert db.get(Event, event_id) is not None


def test_qr_and_check_in_request_ids_are_unique_in_the_database(db, ticket_graph):
    event, attendee, staff, first, second = ticket_graph
    request_id = uuid.uuid4()
    db.add(CheckIn(ticket_id=first.id, event_id=event.id, staff_id=staff.id, request_id=request_id))
    db.commit()
    db.add(CheckIn(ticket_id=second.id, event_id=event.id, staff_id=staff.id, request_id=request_id))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

    # A different event avoids the existing (event_id, attendee_id) unique constraint.
    other_event = Event(organizer_id=event.organizer_id, title="Other event", date=utcnow(), location="Hall", capacity=1)
    db.add(other_event)
    db.flush()
    other_type = TicketType(event_id=other_event.id, name="Бесплатный", quantity=1, is_default=True)
    db.add(other_type)
    db.commit()
    db.add(Ticket(event_id=other_event.id, attendee_id=attendee.id, ticket_type_id=other_type.id, qr_payload=first.qr_payload))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
