from datetime import datetime, timedelta, timezone

DEFAULT_PASSWORD = "S3cret-Passw0rd"


def parse_dt(value: str) -> datetime:
    """Parse an API datetime string into an aware UTC datetime."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def future_iso(days: int = 30) -> str:
    moment = datetime.now(timezone.utc) + timedelta(days=days)
    return moment.replace(microsecond=0).isoformat()


def event_payload(**overrides) -> dict:
    payload = {
        "title": "Palantir Demo Day",
        "description": "Final project showcase",
        "date": future_iso(),
        "location": "Nazarbayev University, Astana",
        "capacity": 150,
    }
    payload.update(overrides)
    return payload


def profile_payload(**overrides) -> dict:
    payload = {
        "organization_name": "NU Robotics Club",
        "description": "Student robotics community",
        "contact_email": "club@example.com",
        "contact_phone": "+7 701 123 45 67",
        "website": "https://robotics.example.com",
    }
    payload.update(overrides)
    return payload
