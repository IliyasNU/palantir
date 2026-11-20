"""Support cases (SRS 4.13): a request tied to its context, with an asynchronous message thread.

An ``attendee`` case is about an event (and optionally the requester's order or ticket) and is handled by that
event's organizer or an admin. An ``organizer`` case is a platform-support request handled by admins.
"""
import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, utcnow


class SupportCaseKind(str, enum.Enum):
    ATTENDEE = "attendee"
    ORGANIZER = "organizer"


class SupportCaseStatus(str, enum.Enum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    WAITING_FOR_CUSTOMER = "waiting_for_customer"
    RESOLVED = "resolved"


class MessageSide(str, enum.Enum):
    REQUESTER = "requester"
    STAFF = "staff"


ATTENDEE_CATEGORIES = (
    "ticket_delivery", "payment", "refund", "seating", "event_information", "check_in", "account", "technical",
)
ORGANIZER_CATEGORIES = ("account", "activation", "payment", "technical")
ALL_CATEGORIES = tuple(dict.fromkeys(ATTENDEE_CATEGORIES + ORGANIZER_CATEGORIES))


def _in(column: str, values) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


class SupportCase(Base):
    __tablename__ = "support_cases"
    __table_args__ = (
        CheckConstraint(_in("kind", [kind.value for kind in SupportCaseKind]), name="kind_valid"),
        CheckConstraint(_in("status", [status.value for status in SupportCaseStatus]), name="status_valid"),
        CheckConstraint(_in("category", ALL_CATEGORIES), name="category_valid"),
        CheckConstraint(_in("last_message_by", [side.value for side in MessageSide]), name="last_message_by_valid"),
        # An attendee case always has an event: that is how its handlers are found.
        CheckConstraint("kind = 'organizer' OR event_id IS NOT NULL", name="attendee_case_has_event"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))
    requester_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    event_id: Mapped[Optional[int]] = mapped_column(ForeignKey("events.id", ondelete="RESTRICT"), index=True)
    order_id: Mapped[Optional[int]] = mapped_column(ForeignKey("orders.id", ondelete="RESTRICT"))
    ticket_id: Mapped[Optional[int]] = mapped_column(ForeignKey("tickets.id", ondelete="RESTRICT"))
    category: Mapped[str] = mapped_column(String(30))
    subject: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(
        String(30), default=SupportCaseStatus.OPEN.value, server_default=SupportCaseStatus.OPEN.value, index=True
    )
    assignee_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())
    # Any activity: a message, a status change or an assignment.
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())
    # Lets a client that polls the lists show "new reply" without reading every thread.
    last_message_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())
    last_message_by: Mapped[str] = mapped_column(String(20))


class SupportMessage(Base):
    """One message of a case's thread. Messages are never edited or deleted: the thread is the case history."""

    __tablename__ = "support_messages"
    __table_args__ = (
        CheckConstraint(_in("author_side", [side.value for side in MessageSide]), name="author_side_valid"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    case_id: Mapped[int] = mapped_column(ForeignKey("support_cases.id", ondelete="RESTRICT"), index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    # Fixed when written: whether the author spoke as the requester or as support staff.
    author_side: Mapped[str] = mapped_column(String(20))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())
