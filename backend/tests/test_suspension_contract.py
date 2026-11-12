"""The shared suspension check that every sales and issuing path calls (docs/architecture.md, suspension contract)."""
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.dependencies.events import ensure_not_suspended
from app.models import Event


def test_ensure_not_suspended_passes_an_event_that_is_not_suspended():
    assert ensure_not_suspended(Event(suspended_at=None)) is None


def test_ensure_not_suspended_refuses_a_suspended_event_with_the_claim_error():
    with pytest.raises(HTTPException) as refused:
        ensure_not_suspended(Event(suspended_at=datetime.now(timezone.utc)))
    assert refused.value.status_code == 409
    assert refused.value.detail == {"code": "EVENT_SUSPENDED", "message": "Ticket sales for this event are suspended"}
