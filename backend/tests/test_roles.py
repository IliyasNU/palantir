"""Role-based access control: the three roles and the `require_roles` dependency."""
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth.security import create_access_token
from app.db.seed import seed_roles
from app.db.session import get_db
from app.dependencies.roles import require_roles
from app.models import Role, RoleName


def test_the_three_roles_are_seeded_once(db):
    seed_roles(db)  # idempotent
    names = sorted(db.scalars(select(Role.name)).all())
    assert names == ["admin", "attendee", "organizer"]


@pytest.fixture()
def rbac_client(session_factory, db):
    """A tiny app with one admin-only and one admin-or-organizer route."""
    mini = FastAPI()

    @mini.get("/admin-only", dependencies=[Depends(require_roles(RoleName.ADMIN))])
    def admin_only():
        return {"ok": True}

    @mini.get("/staff", dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.ORGANIZER))])
    def staff():
        return {"ok": True}

    def override_get_db():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    mini.dependency_overrides[get_db] = override_get_db
    with TestClient(mini) as test_client:
        yield test_client


@pytest.mark.parametrize(
    ("role", "admin_only_status", "staff_status"),
    [("admin", 200, 200), ("organizer", 403, 200), ("attendee", 403, 403)],
)
def test_role_matrix(rbac_client, create_user, role, admin_only_status, staff_status):
    user = create_user(f"{role}@example.com", role=role)
    headers = {"Authorization": f"Bearer {create_access_token(user.id)}"}
    assert rbac_client.get("/admin-only", headers=headers).status_code == admin_only_status
    assert rbac_client.get("/staff", headers=headers).status_code == staff_status


def test_anonymous_requests_get_401(rbac_client):
    assert rbac_client.get("/admin-only").status_code == 401
    assert rbac_client.get("/staff").status_code == 401


def test_require_roles_needs_at_least_one_role():
    with pytest.raises(ValueError):
        require_roles()
