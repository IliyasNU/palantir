"""The Alembic migration must apply (and roll back) cleanly on an empty database."""
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

BACKEND_DIR = Path(__file__).resolve().parents[1]
APP_TABLES = {"roles", "users", "organizer_profiles", "events"}


def alembic_config(url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    return config


def test_upgrade_creates_tables_and_seeds_roles_then_downgrade_removes_them(tmp_path):
    url = f"sqlite:///{tmp_path / 'migration_test.db'}"
    config = alembic_config(url)
    engine = create_engine(url)

    command.upgrade(config, "head")
    assert APP_TABLES <= set(inspect(engine).get_table_names())
    with engine.connect() as connection:
        roles = {row[0] for row in connection.execute(text("SELECT name FROM roles"))}
    assert roles == {"admin", "organizer", "attendee"}

    command.downgrade(config, "base")
    assert not (APP_TABLES & set(inspect(engine).get_table_names()))
    engine.dispose()
