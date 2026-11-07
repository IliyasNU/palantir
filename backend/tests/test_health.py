import pytest
from sqlalchemy.exc import OperationalError, TimeoutError

from app.db.session import get_db
from app.main import app


def test_health_reports_database_up(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "up"}


@pytest.mark.parametrize(
    "failure",
    [
        OperationalError("SELECT private_test_marker", {}, OSError("simulated database disconnect")),
        TimeoutError("simulated connection pool exhaustion"),
    ],
    ids=["connection-error", "pool-timeout"],
)
def test_database_failure_is_a_readable_503_for_registration(client, monkeypatch, failure):
    class UnavailableSession:
        def execute(self, *args, **kwargs):
            raise failure

        scalar = execute

    monkeypatch.setitem(app.dependency_overrides, get_db, UnavailableSession)
    origin = "http://localhost:5173"
    headers = {"Origin": origin}

    health = client.get("/health", headers=headers)
    assert health.status_code == 503
    assert health.json() == {"status": "degraded", "database": "down"}

    registration = client.post(
        "/auth/register",
        json={"email": "db-failure@example.com", "full_name": "Test Visitor", "password": "test-only-password"},
        headers=headers,
    )
    assert registration.status_code == 503
    assert registration.headers["access-control-allow-origin"] == origin
    assert registration.json() == {
        "detail": {"code": "DATABASE_UNAVAILABLE", "message": "The database is temporarily unavailable"}
    }
