"""Import every model here so they are all registered on ``Base.metadata``
(Alembic and ``create_all`` rely on this)."""
from app.models.check_in import CheckIn
from app.models.event import Event, EventStatus
from app.models.event_staff import EventStaff
from app.models.organizer_profile import OrganizerProfile
from app.models.role import Role, RoleName
from app.models.ticket import Ticket
from app.models.user import User

__all__ = ["CheckIn", "Event", "EventStaff", "EventStatus", "OrganizerProfile", "Role", "RoleName", "Ticket", "User"]
