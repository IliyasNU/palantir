"""Reference data that must exist in every database."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Role, RoleName


def seed_roles(db: Session) -> None:
    """Insert the admin / organizer / attendee roles if they are missing (idempotent).

    Production databases get them from the initial Alembic migration; tests and the
    ``create_admin`` script call this as a safety net.
    """
    existing = set(db.scalars(select(Role.name)))
    missing = [role.value for role in RoleName if role.value not in existing]
    for name in missing:
        db.add(Role(name=name))
    if missing:
        db.commit()
