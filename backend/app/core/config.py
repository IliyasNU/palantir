"""Application settings, read from environment variables (or a local ``.env`` file)."""
from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_DEV_SECRET = "dev-only-secret-change-me-0123456789abcdef"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Palantir API"
    environment: str = "development"  # development | test | production

    # Docker Compose overrides this with the `db` hostname.
    database_url: str = "postgresql+psycopg://palantir:palantir@localhost:5432/palantir"

    jwt_secret_key: str = DEFAULT_DEV_SECRET
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = Field(default=30, gt=0)
    refresh_token_expire_days: int = Field(default=7, gt=0)

    # bcrypt cost factor. 12 is a sensible default; the test suite lowers it to 4 for speed.
    bcrypt_rounds: int = Field(default=12, ge=4, le=16)

    # Comma-separated list of browser origins allowed to call the API (CORS).
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @model_validator(mode="after")
    def _reject_default_secret_in_production(self) -> "Settings":
        if self.environment.lower() == "production" and self.jwt_secret_key == DEFAULT_DEV_SECRET:
            raise ValueError("JWT_SECRET_KEY must be changed when ENVIRONMENT=production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
