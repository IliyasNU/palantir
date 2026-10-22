"""Small building blocks shared by several schemas."""
from datetime import datetime, timezone
from typing import Annotated, Any

from pydantic import AfterValidator


def to_utc(value: datetime) -> datetime:
    """Naive datetimes are assumed to be UTC; aware ones are converted to UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def blank_to_none(value: Any) -> Any:
    """Turn empty / whitespace-only strings (typical for blank form inputs) into None."""
    if isinstance(value, str) and not value.strip():
        return None
    return value


# Used for every datetime that enters or leaves the API, so clients always see UTC.
UTCDateTime = Annotated[datetime, AfterValidator(to_utc)]
