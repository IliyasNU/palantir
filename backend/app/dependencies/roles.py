"""Role-based access control (RBAC) as FastAPI dependencies.

    @router.post("/events")
    def create_event(user: OrganizerUser): ...        # organizers only

    @router.get("/x", dependencies=[Depends(require_roles(RoleName.ADMIN))])
"""
from collections.abc import Callable
from typing import Annotated, Union

from fastapi import Depends, HTTPException, status

from app.dependencies.auth import get_current_user
from app.models import RoleName, User


def require_roles(*allowed_roles: Union[RoleName, str]) -> Callable[..., User]:
    """Build a dependency that lets only users holding one of ``allowed_roles`` through.

    Anonymous callers get 401 (from ``get_current_user``); authenticated users with the
    wrong role get 403.
    """
    allowed = {role.value if isinstance(role, RoleName) else role for role in allowed_roles}
    if not allowed:
        raise ValueError("require_roles() needs at least one role")

    def role_checker(current_user: Annotated[User, Depends(get_current_user)]) -> User:
        if current_user.role.name not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have permission to do this")
        return current_user

    return role_checker


def is_admin(user: User) -> bool:
    return user.role.name == RoleName.ADMIN.value


require_admin = require_roles(RoleName.ADMIN)
require_organizer = require_roles(RoleName.ORGANIZER)

AdminUser = Annotated[User, Depends(require_admin)]
OrganizerUser = Annotated[User, Depends(require_organizer)]
