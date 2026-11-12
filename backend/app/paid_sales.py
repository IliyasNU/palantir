"""Activation checklist, recomputed under the event lock; all amounts are demo tiyn."""
from sqlalchemy import select

from app.audit import record_action
from app.db.base import utcnow
from app.demo_fees import DEMO_NOTICE, PAID_SALES_ACTIVATION_FEE_TIYN
from app.models import OrganizerProfile, TicketType
from app.models.order import PaidSalesActivation


def activation_state(db, event, actor_id=None):
    activation = db.get(PaidSalesActivation, event.id)
    profile = db.scalar(select(OrganizerProfile).where(OrganizerProfile.user_id == event.organizer_id)
                        .execution_options(populate_existing=True))
    steps = {
        "paid_type": db.scalar(select(TicketType.id).where(TicketType.event_id == event.id,
                                                          TicketType.price_tiyn > 0).limit(1)) is not None,
        "identity": profile is not None and profile.demo_identity_confirmed_at is not None,
        "payout": profile is not None and profile.demo_payout_last4 is not None,
        "terms": activation is not None and activation.terms_accepted_at is not None,
        "fee": activation is not None and activation.fee_paid_at is not None,
    }
    active = all(steps.values())
    if active and activation.activated_at is None and actor_id is not None:
        activation.activated_at = utcnow()
        record_action(db, event_id=event.id, actor_id=actor_id, action="paid_sales.activated",
                      entity_type="event", entity_id=event.id, description="Simulated paid sales activated")
    suspended = activation is not None and activation.suspended_at is not None
    return {"event_id": event.id, "steps": {key: {"done": value} for key, value in steps.items()},
            "activated": active, "paid_sales_suspended": suspended,
            "activation_fee_tiyn": PAID_SALES_ACTIVATION_FEE_TIYN,
            "fee_paid_tiyn": activation.fee_tiyn if activation else None,
            "fee_paid_at": activation.fee_paid_at if activation else None,
            "simulation": True, "demo_notice": DEMO_NOTICE}
