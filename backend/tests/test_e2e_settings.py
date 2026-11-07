"""Live database tests must fail before I/O unless their targets are explicit and isolated."""
import pytest

from e2e.settings import read_e2e_settings


def _settings():
    return {
        "RUN_POSTGRES_E2E": "1",
        "ENVIRONMENT": "test",
        "E2E_BASE_URL": "http://localhost:8000",
        "E2E_DATABASE_URL": "postgresql+psycopg://test_user:test-only@127.0.0.1:5432/biletflow_test",
        "JWT_SECRET_KEY": "test-only-key-for-settings-validation",
    }


@pytest.mark.parametrize("missing", ["RUN_POSTGRES_E2E", "ENVIRONMENT", "E2E_BASE_URL", "E2E_DATABASE_URL", "JWT_SECRET_KEY"])
def test_live_settings_require_opt_in_and_explicit_targets(missing):
    values = _settings()
    del values[missing]
    with pytest.raises(ValueError):
        read_e2e_settings(values)


@pytest.mark.parametrize("override", [
    {"ENVIRONMENT": "production"},
    {"E2E_BASE_URL": "https://api.example.com"},
    {"E2E_BASE_URL": "http://localhost:8000/api"},
    {"E2E_BASE_URL": "http://user:do-not-print@localhost:8000"},
    {"E2E_DATABASE_URL": "postgresql+psycopg://user:do-not-print@127.0.0.1:5432/palantir"},
    {"E2E_DATABASE_URL": "postgresql+psycopg://user:do-not-print@example.com:5432/biletflow_test"},
    {"E2E_DATABASE_URL": "sqlite:///test.db"},
    {"E2E_DATABASE_URL": "not a URL"},
    {"E2E_DATABASE_URL": "postgresql+psycopg://user:do-not-print@127.0.0.1:5432/biletflow_test?host=example.com"},
])
def test_live_settings_reject_unsafe_targets_without_revealing_secrets(override):
    values = {**_settings(), **override}
    with pytest.raises(ValueError) as failure:
        read_e2e_settings(values)
    assert "do-not-print" not in str(failure.value)


def test_live_settings_accept_a_named_local_test_database_without_changing_input():
    values = _settings()
    before = values.copy()
    result = read_e2e_settings(values)
    assert result.base_url == values["E2E_BASE_URL"]
    assert result.database_url == values["E2E_DATABASE_URL"]
    assert values == before
