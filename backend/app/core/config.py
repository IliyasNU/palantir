"""Application settings, read from environment variables (or a local ``.env`` file)."""
from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_DEV_SECRET = "dev-only-secret-change-me-0123456789abcdef"
MIN_JWT_SECRET_BYTES = {"HS256": 32, "HS384": 48, "HS512": 64}
PUBLIC_PLACEHOLDER_SECRETS = {
    DEFAULT_DEV_SECRET,
    "test-secret-key-for-pytest-only-0123456789",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    app_name: str = "Palantir API"
    environment: Literal["development", "test", "production"] = "development"

    # Docker Compose overrides this with the `db` hostname.
    database_url: str = "postgresql+psycopg://palantir:palantir@localhost:5432/palantir"

    jwt_secret_key: str = DEFAULT_DEV_SECRET
    jwt_algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
    access_token_expire_minutes: int = Field(default=30, gt=0)
    refresh_token_expire_days: int = Field(default=7, gt=0)

    # bcrypt cost factor. 12 is a sensible default; the test suite lowers it to 4 for speed.
    bcrypt_rounds: int = Field(default=12, ge=4, le=16)

    # Comma-separated list of browser origins allowed to call the API (CORS).
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    # Email links open the web app here.
    frontend_url: str = "http://localhost:5173"
    email_verify_expire_hours: int = Field(default=48, gt=0)
    password_reset_expire_minutes: int = Field(default=60, gt=0)

    # Empty SMTP_HOST: emails are logged instead of sent (bodies only outside production).
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_starttls: bool = True
    email_from: str = "BiletFlow <no-reply@biletflow.local>"

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @model_validator(mode="after")
    def _require_production_secret(self) -> "Settings":
        secret = self.jwt_secret_key
        if not secret.strip():
            raise ValueError("JWT_SECRET_KEY must not be empty or whitespace")
        if self.environment != "production":
            return self

        placeholder = "-".join(secret.casefold().replace("_", "-").split())
        if (
            secret.strip() in PUBLIC_PLACEHOLDER_SECRETS
            or "change-me" in placeholder
            or "changeme" in placeholder
        ):
            raise ValueError("JWT_SECRET_KEY must be a new random secret when ENVIRONMENT=production")

        minimum = MIN_JWT_SECRET_BYTES[self.jwt_algorithm]
        if len(secret.encode("utf-8")) < minimum:
            raise ValueError(f"JWT_SECRET_KEY must contain at least {minimum} bytes for {self.jwt_algorithm}")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
