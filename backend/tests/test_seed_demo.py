from sqlalchemy import select

from app.auth.security import verify_password
from app.db import session
from app.models import ActionLog, CheckIn, Event, EventStaff, Ticket, TicketStatus, TicketType, User
from app.models.campaign import Campaign
from app.models.event import EventPhase
from app.models.order import Order
from app.models.support import SupportCase, SupportMessage
from scripts import seed_demo


def test_demo_seed_runs_twice_on_a_fresh_database(session_factory, monkeypatch, capsys):
    monkeypatch.setattr(session, "SessionLocal", session_factory)

    monkeypatch.setenv("ENVIRONMENT", "production")
    assert seed_demo.main() == 2
    assert "disabled in production" in capsys.readouterr().err
    with session_factory() as db:
        assert db.scalar(select(User.id).limit(1)) is None
    monkeypatch.setenv("ENVIRONMENT", "test")

    assert seed_demo.main() == 0
    credentials = dict(line.split(": ", 1)[1].split(" / ", 1)
                       for line in capsys.readouterr().out.splitlines() if " / " in line)
    with session_factory() as db:
        users = db.scalars(select(User).order_by(User.id)).all()
        assert [user.role.name for user in users] == ["admin", "organizer", "organizer"] + ["attendee"] * 4
        assert len(set(credentials.values())) == 7
        assert all(verify_password(credentials[user.email], user.hashed_password) for user in users)
        credentials_before = [(user.id, user.email, user.hashed_password) for user in users]

        events = {event.title: event for event in db.scalars(select(Event))}
        assert events["Demo | Draft"].status == "draft"
        assert events["Demo | Upcoming checkout"].phase == EventPhase.UPCOMING
        assert events["Demo | Active check-in"].phase == EventPhase.ACTIVE
        assert events["Demo | Past check-in"].phase == EventPhase.COMPLETED
        assert events["Demo | Cancelled"].phase == EventPhase.CANCELLED
        assert events["Demo | Suspended"].suspended_at is not None
        assignments = db.scalars(select(EventStaff)).all()
        assert [(assignment.event_id, assignment.user.email) for assignment in assignments] == [
            (events["Demo | Active check-in"].id, "biletflow-demo-staff@example.com"),
        ]

        tickets = db.scalars(select(Ticket)).all()
        assert sum(ticket.status == TicketStatus.REFUNDED for ticket in tickets) == 1
        assert {kind.price_tiyn for kind in db.scalars(select(TicketType))} == {0, 250_000}
        for event in events.values():
            active = [ticket for ticket in tickets if ticket.event_id == event.id and ticket.status == "active"]
            assert event.tickets_issued == len(active)
            assert sum(kind.tickets_issued for kind in event.ticket_types) == len(active)

        campaign = db.scalars(select(Campaign)).one()
        orders = db.scalars(select(Order).order_by(Order.total_tiyn)).all()
        assert [(order.status, order.total_tiyn, order.campaign_id) for order in orders] == [
            ("paid", 200_000, campaign.id), ("paid", 250_000, None),
        ]
        case = db.scalars(select(SupportCase)).one()
        assert (case.order_id, case.ticket_id, case.requester_id) == (
            orders[0].id, orders[0].ticket_id, orders[0].buyer_id,
        )
        assert len(db.scalars(select(SupportMessage).where(SupportMessage.case_id == case.id)).all()) == 3
        assert len(db.scalars(select(CheckIn)).all()) == 2
        assert db.scalars(select(ActionLog).where(ActionLog.action == seed_demo.SEED_ACTION)).one()
        # IDs across the demo data and the append-only log must stay identical on a repeat invocation.
        models = (Event, TicketType, Ticket, Order, Campaign, SupportCase, SupportMessage, CheckIn, ActionLog)
        row_ids = {model: db.scalars(select(model.id).order_by(model.id)).all() for model in models}

    assert seed_demo.main() == 0
    assert capsys.readouterr().out == "BiletFlow demo data is already installed. Credentials are unchanged.\n"
    with session_factory() as db:
        assert db.execute(select(User.id, User.email, User.hashed_password).order_by(User.id)).all() == credentials_before
        assert {model: db.scalars(select(model.id).order_by(model.id)).all() for model in models} == row_ids
