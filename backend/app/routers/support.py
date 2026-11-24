"""Support cases (SRS 4.13): open a request from an event, order or ticket, and talk it through.

Two kinds of case:

* ``attendee``: any signed-in user asks the organizer of an event. Handled by that event's organizer or an admin.
* ``organizer``: an organizer asks platform support. Handled by admins.

A case is visible only to its requester and its handlers; everyone else gets ``404 CASE_NOT_FOUND``.
The thread is plain REST, read by periodic refresh (``GET .../messages?after_id=``). Status changes and
assignments are written to the action log in the same transaction; message text never is.
"""
from dataclasses import dataclass
from typing import Annotated, Optional

from fastapi import APIRouter, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from app.audit import record_action
from app.db.base import utcnow
from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.events import can_manage, ensure_can_manage, get_event_or_404, is_visible
from app.dependencies.roles import AdminUser, is_admin
from app.errors import api_error
from app.notifications import notify
from app.models import Event, Role, RoleName, Ticket, User
from app.models.order import Order
from app.models.support import (
    ATTENDEE_CATEGORIES,
    ORGANIZER_CATEGORIES,
    MessageSide,
    SupportCase,
    SupportCaseKind,
    SupportCaseStatus,
    SupportMessage,
)
from app.schemas.attendance import mask_email
from app.schemas.support import (
    CaseContext,
    CaseCreate,
    CaseRead,
    CaseSummary,
    CaseUpdate,
    EventContext,
    Kind,
    MessageCreate,
    MessageRead,
    OrderContext,
    PersonRead,
    RequesterRead,
    Status,
    TicketContext,
)

router = APIRouter(tags=["support"])

PAGE_DEFAULT = 50
PAGE_MAX = 100
MESSAGES_MAX = 500
PageLimit = Annotated[int, Query(ge=1, le=PAGE_MAX)]
PageOffset = Annotated[int, Query(ge=0, le=1_000_000)]

# What a reply from the requester does to a case that was waiting for them or already closed.
_REOPENED_BY_REPLY = {
    SupportCaseStatus.WAITING_FOR_CUSTOMER.value: SupportCaseStatus.IN_PROGRESS.value,
    SupportCaseStatus.RESOLVED.value: SupportCaseStatus.OPEN.value,
}


def _not_found():
    return api_error(status.HTTP_404_NOT_FOUND, "CASE_NOT_FOUND", "Support case not found")


@dataclass
class _Access:
    case: SupportCase
    event: Optional[Event]
    is_requester: bool
    is_handler: bool

    @property
    def side(self) -> str:
        """The side this user writes as. Someone who opened the case speaks as its requester."""
        return MessageSide.REQUESTER.value if self.is_requester else MessageSide.STAFF.value


def _handles(case: SupportCase, event: Optional[Event], user: User) -> bool:
    if is_admin(user):
        return True
    return case.kind == SupportCaseKind.ATTENDEE.value and event is not None and event.organizer_id == user.id


def _load(db: Session, case_id: int, user: User, lock: bool = False) -> _Access:
    """The case, if this user is its requester or one of its handlers. Everyone else learns nothing: 404."""
    query = select(SupportCase).where(SupportCase.id == case_id)
    if lock:  # a reply and a status change of the same case wait for each other
        query = query.with_for_update().execution_options(populate_existing=True)
    case = db.scalar(query)
    if case is None:
        raise _not_found()
    event = db.get(Event, case.event_id) if case.event_id is not None else None
    access = _Access(case, event, is_requester=case.requester_id == user.id, is_handler=_handles(case, event, user))
    if not (access.is_requester or access.is_handler):
        raise _not_found()
    return access


def _summaries(db: Session, *conditions, limit: int = PAGE_DEFAULT, offset: int = 0) -> list[CaseSummary]:
    """Cases with the names a list needs, most recent activity first."""
    requester, assignee = aliased(User), aliased(User)
    query = (
        select(SupportCase, requester.full_name, requester.email, assignee.full_name, Event.title)
        .join(requester, requester.id == SupportCase.requester_id)
        .outerjoin(assignee, assignee.id == SupportCase.assignee_id)
        .outerjoin(Event, Event.id == SupportCase.event_id)
        .where(*conditions)
        .order_by(SupportCase.updated_at.desc(), SupportCase.id.desc())
        .limit(limit)
        .offset(offset)
    )
    return [
        CaseSummary(
            id=case.id, kind=case.kind, category=case.category, subject=case.subject, status=case.status,
            requester=RequesterRead(id=case.requester_id, full_name=requester_name, masked_email=mask_email(email)),
            assignee=PersonRead(id=case.assignee_id, full_name=assignee_name) if case.assignee_id else None,
            event_id=case.event_id, event_title=event_title, order_id=case.order_id, ticket_id=case.ticket_id,
            created_at=case.created_at, updated_at=case.updated_at,
            last_message_at=case.last_message_at, last_message_by=case.last_message_by,
        )
        for case, requester_name, email, assignee_name, event_title in db.execute(query)
    ]


def _messages(db: Session, case_id: int, after_id: int = 0, limit: int = MESSAGES_MAX) -> list[MessageRead]:
    query = (
        select(SupportMessage, User.full_name)
        .join(User, User.id == SupportMessage.author_id)
        .where(SupportMessage.case_id == case_id, SupportMessage.id > after_id)
        .order_by(SupportMessage.id)
        .limit(limit)
    )
    return [
        MessageRead(
            id=message.id, case_id=message.case_id, author_id=message.author_id, author_name=author_name,
            author_side=message.author_side, body=message.body, created_at=message.created_at,
        )
        for message, author_name in db.execute(query)
    ]


def _case_read(db: Session, access: _Access) -> CaseRead:
    case = access.case
    [summary] = _summaries(db, SupportCase.id == case.id)
    order = db.get(Order, case.order_id) if case.order_id is not None else None
    ticket = db.get(Ticket, case.ticket_id) if case.ticket_id is not None else None
    event = access.event
    return CaseRead(
        **summary.model_dump(),
        viewer_side=access.side,
        can_manage=access.is_handler,
        context=CaseContext(
            event=EventContext(id=event.id, title=event.title, status=event.status) if event else None,
            order=OrderContext(id=order.id, status=order.status, total_tiyn=order.total_tiyn) if order else None,
            ticket=TicketContext(id=ticket.id, status=ticket.status) if ticket else None,
        ),
        messages=_messages(db, case.id),
    )


def _mismatch(message: str):
    return api_error(422, "CONTEXT_MISMATCH", message)


def _attendee_context(db: Session, payload: CaseCreate, user: User) -> tuple[Event, Optional[Order], Optional[Ticket]]:
    """Check the ids the client sent and complete the context: a ticket brings its order, an order its ticket."""
    ticket = order = None
    if payload.ticket_id is not None:
        ticket = db.get(Ticket, payload.ticket_id)
        if ticket is None or ticket.attendee_id != user.id:
            raise api_error(status.HTTP_404_NOT_FOUND, "TICKET_NOT_FOUND", "Ticket not found")
    if payload.order_id is not None:
        order = db.get(Order, payload.order_id)
        if order is None or order.buyer_id != user.id:
            raise api_error(status.HTTP_404_NOT_FOUND, "ORDER_NOT_FOUND", "Order not found")

    if ticket is not None and order is not None and order.ticket_id != ticket.id:
        raise _mismatch("The order and the ticket do not belong together")
    if order is not None and ticket is None and order.ticket_id is not None:
        ticket = db.get(Ticket, order.ticket_id)
    if ticket is not None and order is None:
        order = db.scalar(select(Order).where(Order.ticket_id == ticket.id))

    event_ids = {item.event_id for item in (ticket, order) if item is not None}
    if payload.event_id is not None:
        event_ids.add(payload.event_id)
    if not event_ids:
        raise api_error(422, "CONTEXT_REQUIRED", "Say which event, order or ticket the request is about")
    if len(event_ids) > 1:
        raise _mismatch("The event does not match the order or ticket")

    event = db.get(Event, event_ids.pop())
    # A ticket or order of their own already ties the requester to the event, even if it is now hidden.
    if event is None or (ticket is None and order is None and not is_visible(db, event, user)):
        raise api_error(status.HTTP_404_NOT_FOUND, "EVENT_NOT_FOUND", "Event not found")
    return event, order, ticket


def _organizer_context(db: Session, payload: CaseCreate, user: User) -> Optional[Event]:
    if user.role.name != RoleName.ORGANIZER.value:
        raise api_error(status.HTTP_403_FORBIDDEN, "FORBIDDEN", "Only organizers can open a platform support case")
    if payload.order_id is not None or payload.ticket_id is not None:
        raise _mismatch("A platform support case can refer to one of your events only")
    if payload.event_id is None:
        return None
    event = db.get(Event, payload.event_id)
    if event is None or not can_manage(event, user):
        raise api_error(status.HTTP_404_NOT_FOUND, "EVENT_NOT_FOUND", "Event not found")
    return event


@router.post("/support/cases", response_model=CaseRead, status_code=status.HTTP_201_CREATED)
def open_case(payload: CaseCreate, db: DbSession, current_user: CurrentUser):
    """Open a support request with its first message."""
    organizer_case = payload.kind == SupportCaseKind.ORGANIZER.value
    if payload.category not in (ORGANIZER_CATEGORIES if organizer_case else ATTENDEE_CATEGORIES):
        raise api_error(422, "CATEGORY_NOT_ALLOWED", "This category is not available for this kind of case")
    order = ticket = None
    if organizer_case:
        event = _organizer_context(db, payload, current_user)
    else:
        event, order, ticket = _attendee_context(db, payload, current_user)

    now = utcnow()
    case = SupportCase(
        kind=payload.kind, requester_id=current_user.id, event_id=event.id if event else None,
        order_id=order.id if order else None, ticket_id=ticket.id if ticket else None,
        category=payload.category, subject=payload.subject, status=SupportCaseStatus.OPEN.value,
        created_at=now, updated_at=now, last_message_at=now, last_message_by=MessageSide.REQUESTER.value,
    )
    db.add(case)
    db.flush()
    db.add(SupportMessage(case_id=case.id, author_id=current_user.id, author_side=MessageSide.REQUESTER.value,
                          body=payload.message, created_at=now))
    record_action(db, event_id=case.event_id, actor_id=current_user.id, action="support_case.opened",
                  entity_type="support_case", entity_id=case.id,
                  description=f"Opened a support case: {payload.category}")
    db.commit()
    return _case_read(db, _load(db, case.id, current_user))


@router.get("/support/cases/mine", response_model=list[CaseSummary])
def list_my_cases(
    db: DbSession, current_user: CurrentUser, status: Optional[Status] = None,
    limit: PageLimit = PAGE_DEFAULT, offset: PageOffset = 0,
):
    """The cases you opened, most recent activity first."""
    conditions = [SupportCase.requester_id == current_user.id]
    if status is not None:
        conditions.append(SupportCase.status == status)
    return _summaries(db, *conditions, limit=limit, offset=offset)


@router.get("/events/{event_id}/support-cases", response_model=list[CaseSummary])
def list_event_cases(
    event_id: int, db: DbSession, current_user: CurrentUser, status: Optional[Status] = None,
    limit: PageLimit = PAGE_DEFAULT, offset: PageOffset = 0,
):
    """Attendee cases about this event (its organizer or an admin)."""
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    conditions = [SupportCase.event_id == event.id, SupportCase.kind == SupportCaseKind.ATTENDEE.value]
    if status is not None:
        conditions.append(SupportCase.status == status)
    return _summaries(db, *conditions, limit=limit, offset=offset)


@router.get("/admin/support-cases", response_model=list[CaseSummary])
def list_all_cases(
    db: DbSession, admin: AdminUser, kind: Optional[Kind] = None, status: Optional[Status] = None,
    limit: PageLimit = PAGE_DEFAULT, offset: PageOffset = 0,
):
    """Every case on the platform (admin). ``kind=organizer`` is the platform-support queue."""
    conditions = []
    if kind is not None:
        conditions.append(SupportCase.kind == kind)
    if status is not None:
        conditions.append(SupportCase.status == status)
    return _summaries(db, *conditions, limit=limit, offset=offset)


@router.get("/support/cases/{case_id}", response_model=CaseRead)
def read_case(case_id: int, db: DbSession, current_user: CurrentUser):
    """A case with its context and whole thread (its requester or a handler)."""
    return _case_read(db, _load(db, case_id, current_user))


@router.get("/support/cases/{case_id}/messages", response_model=list[MessageRead])
def read_messages(
    case_id: int, db: DbSession, current_user: CurrentUser,
    after_id: Annotated[int, Query(ge=0, le=2_147_483_647)] = 0,
):
    """Messages newer than ``after_id``, oldest first: what a client asks for on each periodic refresh."""
    access = _load(db, case_id, current_user)
    return _messages(db, access.case.id, after_id=after_id)


def _notify_participants(db: Session, access: _Access, actor: User, kind: str, body: str) -> None:
    case = access.case
    recipients = {case.requester_id}
    if case.assignee_id is not None:
        recipients.add(case.assignee_id)
    elif case.kind == SupportCaseKind.ATTENDEE.value and access.event is not None:
        recipients.add(access.event.organizer_id)
    else:
        recipients.update(db.scalars(select(User.id).join(Role).where(Role.name == RoleName.ADMIN.value)))
    recipients.discard(actor.id)
    for user in db.scalars(select(User).where(User.id.in_(recipients), User.is_active.is_(True))):
        notify(db, user, kind, f"Поддержка / Қолдау / Support #{case.id}", body,
               link=f"/support/cases/{case.id}")


def _set_status(db: Session, case: SupportCase, new_status: str, actor: User) -> None:
    old_status = case.status
    case.status = new_status
    record_action(db, event_id=case.event_id, actor_id=actor.id, action="support_case.status_changed",
                  entity_type="support_case", entity_id=case.id, description=f"status: {old_status} -> {new_status}")


@router.post("/support/cases/{case_id}/messages", response_model=MessageRead, status_code=status.HTTP_201_CREATED)
def post_message(case_id: int, payload: MessageCreate, db: DbSession, current_user: CurrentUser):
    """Reply in the thread. A reply from the requester reopens a case that was waiting for them or resolved."""
    access = _load(db, case_id, current_user, lock=True)
    case, now = access.case, utcnow()
    message = SupportMessage(case_id=case.id, author_id=current_user.id, author_side=access.side,
                             body=payload.body, created_at=now)
    db.add(message)
    case.last_message_at = now
    case.last_message_by = access.side
    case.updated_at = now
    body = "Новый ответ. / Жаңа жауап. / New reply."
    if access.is_requester and case.status in _REOPENED_BY_REPLY:
        _set_status(db, case, _REOPENED_BY_REPLY[case.status], current_user)
        body += " Статус изменён. / Күй өзгерді. / Status changed."
    _notify_participants(db, access, current_user, "support.reply", body)
    db.commit()
    return MessageRead(
        id=message.id, case_id=case.id, author_id=current_user.id, author_name=current_user.full_name,
        author_side=message.author_side, body=message.body, created_at=message.created_at,
    )


def _valid_assignee(db: Session, access: _Access, assignee_id: int) -> User:
    assignee = db.get(User, assignee_id)
    if assignee is None or not assignee.is_active or not _handles(access.case, access.event, assignee):
        raise api_error(422, "INVALID_ASSIGNEE", "A case can be assigned only to someone who handles it")
    return assignee


@router.patch("/support/cases/{case_id}", response_model=CaseRead)
def update_case(case_id: int, payload: CaseUpdate, db: DbSession, current_user: CurrentUser):
    """Change the status or the assignee. Handlers may do both; the requester may only mark the case resolved."""
    access = _load(db, case_id, current_user, lock=True)
    case, sent = access.case, payload.model_fields_set
    requester_closing = sent == {"status"} and payload.status == SupportCaseStatus.RESOLVED.value
    if not access.is_handler and sent and not requester_closing:
        raise api_error(
            status.HTTP_403_FORBIDDEN, "FORBIDDEN", "Only support staff can assign a case or set this status"
        )

    changed = False
    status_changed = "status" in sent and payload.status != case.status
    if status_changed:
        _set_status(db, case, payload.status, current_user)
        changed = True
    if "assignee_id" in sent and payload.assignee_id != case.assignee_id:
        if payload.assignee_id is not None:
            _valid_assignee(db, access, payload.assignee_id)
        case.assignee_id = payload.assignee_id
        record_action(
            db, event_id=case.event_id, actor_id=current_user.id, action="support_case.assigned",
            entity_type="support_case", entity_id=case.id,
            description=f"Assigned to user {payload.assignee_id}" if payload.assignee_id else "Assignment removed",
        )
        changed = True
    if status_changed:
        _notify_participants(db, access, current_user, "support.status", "Статус изменён. / Күй өзгерді. / Status changed.")
    if changed:  # repeating the same change is a no-op and writes nothing
        case.updated_at = utcnow()
    db.commit()
    return _case_read(db, access)
