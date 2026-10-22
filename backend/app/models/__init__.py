"""Import every model here so they are all registered on ``Base.metadata``
(Alembic and ``create_all`` rely on this)."""
from app.models.event import Event
from app.models.organizer_profile import OrganizerProfile
from app.models.role import Role, RoleName
from app.models.user import User

__all__ = ["Event", "OrganizerProfile", "Role", "RoleName", "User"]
