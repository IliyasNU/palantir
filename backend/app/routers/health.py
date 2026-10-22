from fastapi import APIRouter, Response, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.dependencies.db import DbSession

router = APIRouter(tags=["health"])


@router.get("/health")
def health(db: DbSession, response: Response):
    """Liveness + database connectivity check."""
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "degraded", "database": "down"}
    return {"status": "ok", "database": "up"}
