"""Query filters shared by the event timeline and the platform-wide history."""
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Optional

from fastapi import Depends, Query

from app.schemas.common import to_utc

LOG_PAGE_DEFAULT = 200
LOG_PAGE_MAX = 500


@dataclass(frozen=True)
class ActionLogFilters:
    date_from: Optional[datetime]
    date_to: Optional[datetime]
    action: Optional[str]
    limit: int
    offset: int


def action_log_filters(
    date_from: Annotated[Optional[datetime], Query(description="Only actions at or after this time")] = None,
    date_to: Annotated[Optional[datetime], Query(description="Only actions at or before this time")] = None,
    action: Annotated[
        Optional[str], Query(max_length=80, description="Action type or prefix, for example check_in or event.published")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=LOG_PAGE_MAX)] = LOG_PAGE_DEFAULT,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
) -> ActionLogFilters:
    # Naive values are UTC, as everywhere else in the API.
    return ActionLogFilters(
        date_from=to_utc(date_from) if date_from is not None else None,
        date_to=to_utc(date_to) if date_to is not None else None,
        action=action.strip() or None if action else None,
        limit=limit,
        offset=offset,
    )


LogFilters = Annotated[ActionLogFilters, Depends(action_log_filters)]
