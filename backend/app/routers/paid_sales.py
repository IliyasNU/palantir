from fastapi import APIRouter
from sqlalchemy import select

from app.audit import record_action
from app.db.base import utcnow
from app.demo_fees import DEMO_NOTICE, PAID_SALES_ACTIVATION_FEE_TIYN
from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.events import ensure_can_manage, ensure_not_suspended
from app.dependencies.roles import AdminUser, OrganizerUser
from app.errors import api_error
from app.models import Event, OrganizerProfile
from app.models.order import PaidSalesActivation
from app.paid_sales import activation_state
from app.schemas.order import PayoutRequest, SuspensionRequest
from app.ticket_types import lock_event

router = APIRouter(tags=["demo paid sales"])


def managed_event(db, event_id, user):
    event = lock_event(db, event_id)
    ensure_can_manage(event, user)
    return event


@router.get("/events/{event_id}/activation")
def read_activation(event_id: int, db: DbSession, user: CurrentUser):
    event = managed_event(db, event_id, user)
    result = activation_state(db, event, user.id)
    db.commit()
    return result


def activation_step(db, event_id, user, step):
    event = managed_event(db, event_id, user)
    ensure_not_suspended(event)
    activation = db.get(PaidSalesActivation, event_id)
    if activation is None:
        activation = PaidSalesActivation(event_id=event_id)
        db.add(activation)
    field = "terms_accepted_at" if step == "terms" else "fee_paid_at"
    if getattr(activation, field) is None:
        setattr(activation, field, utcnow())
        if step == "fee":
            activation.fee_tiyn = PAID_SALES_ACTIVATION_FEE_TIYN
        record_action(db, event_id=event_id, actor_id=user.id, action=f"paid_sales.{step}_accepted" if step == "terms"
                      else "paid_sales.fee_paid", entity_type="event", entity_id=event_id,
                      description="Demo terms accepted" if step == "terms" else f"Demo activation fee: {activation.fee_tiyn} tiyn")
    db.flush()
    result = activation_state(db, event, user.id)
    db.commit()
    return result


@router.post("/events/{event_id}/activation/terms")
def accept_terms(event_id: int, db: DbSession, user: CurrentUser):
    return activation_step(db, event_id, user, "terms")


@router.post("/events/{event_id}/activation/fee")
def pay_fee(event_id: int, db: DbSession, user: CurrentUser):
    return activation_step(db, event_id, user, "fee")


def confirm_profile(db, user, suffix=None):
    # Event locks precede profile locks everywhere, including simultaneous activation/checkout.
    events = db.scalars(select(Event).where(Event.organizer_id == user.id).order_by(Event.id)).all()
    for event in events:
        lock_event(db, event.id)
    profile = db.scalar(select(OrganizerProfile).where(OrganizerProfile.user_id == user.id).with_for_update()
                        .execution_options(populate_existing=True))
    if profile is None:
        raise api_error(404, "ORGANIZER_PROFILE_NOT_FOUND", "Create your organizer profile first")
    if suffix is None:
        profile.demo_identity_confirmed_at = profile.demo_identity_confirmed_at or utcnow()
    else:
        profile.demo_payout_last4 = suffix
    db.flush()
    for event in events:
        activation_state(db, event, user.id)
    db.commit()
    return {"identity_confirmed": profile.demo_identity_confirmed_at is not None,
            "payout_last4": profile.demo_payout_last4, "simulation": True, "demo_notice": DEMO_NOTICE}


@router.post("/organizer-profiles/me/confirm-identity")
def confirm_identity(db: DbSession, user: OrganizerUser):
    return confirm_profile(db, user)


@router.post("/organizer-profiles/me/payout-details")
def payout_details(payload: PayoutRequest, db: DbSession, user: OrganizerUser):
    return confirm_profile(db, user, payload.reference_last4)


def set_suspension(db, event_id, user, reason):
    event = lock_event(db, event_id)
    activation = db.get(PaidSalesActivation, event_id)
    if activation is None:
        activation = PaidSalesActivation(event_id=event_id)
        db.add(activation)
    changed = (activation.suspended_at is not None) != (reason is not None)
    if changed:
        activation.suspended_at = utcnow() if reason is not None else None
        activation.suspension_reason = reason
        record_action(db, event_id=event_id, actor_id=user.id,
                      action="paid_sales.suspended" if reason else "paid_sales.restored",
                      entity_type="event", entity_id=event_id, description=reason or "Demo paid sales restored")
    db.flush()
    result = activation_state(db, event, user.id)
    db.commit()
    return result


@router.post("/admin/events/{event_id}/paid-sales/suspend")
def suspend(event_id: int, payload: SuspensionRequest, db: DbSession, user: AdminUser):
    return set_suspension(db, event_id, user, payload.reason)


@router.post("/admin/events/{event_id}/paid-sales/restore")
def restore(event_id: int, db: DbSession, user: AdminUser):
    return set_suspension(db, event_id, user, None)
