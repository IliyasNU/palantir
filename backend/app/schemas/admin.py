from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, StringConstraints

from app.schemas.common import UTCDateTime
from app.schemas.event import EventRead


class SuspendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Stored in the action log, where the event's organizer can read it.
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=300)]


class AdminEventRead(EventRead):
    suspended_at: Optional[UTCDateTime]
