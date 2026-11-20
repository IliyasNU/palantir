from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.schemas.common import UTCDateTime


class NotificationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    body: str
    link: Optional[str]
    created_at: UTCDateTime
    read_at: Optional[UTCDateTime]
