import json

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sqlalchemy.exc import DataError, OperationalError, TimeoutError as DatabaseTimeoutError

from app import __version__
from app.auth.router import router as auth_router
from app.core.config import get_settings
from app.routers import attendance, check_ins, events, health, organizer_profiles, staff, tickets

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version=__version__,
    description=(
        "Backend of the Palantir event-ticketing platform (CSCI 361). "
        "Current scope: authentication, role-based access control, organizer profiles, events, tickets, "
        "per-event staff and check-in."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



@app.exception_handler(RequestValidationError)
def reject_invalid_request(request: Request, exc: RequestValidationError) -> Response:
    """FastAPI's default 422 body without the echoed ``input``.

    Raw input may be bytes, lone surrogates or 1e400 (Infinity), none of which encode to valid JSON.
    Clients only use ``loc`` and ``msg``.
    """
    errors = [{key: value for key, value in error.items() if key != "input"} for error in exc.errors()]
    body = json.dumps({"detail": jsonable_encoder(errors)}, ensure_ascii=True, allow_nan=False)
    return Response(body, status_code=422, media_type="application/json")


@app.exception_handler(DataError)
def reject_unstorable_input(request: Request, exc: DataError) -> JSONResponse:
    """PostgreSQL refused a value Pydantic let through (NUL characters, ids beyond its integer range)."""
    return JSONResponse(
        status_code=422,
        content={"detail": {"code": "INVALID_INPUT", "message": "The request contains a value that cannot be stored"}},
    )


@app.exception_handler(OperationalError)
@app.exception_handler(DatabaseTimeoutError)
def database_unavailable(request: Request, exc: OperationalError | DatabaseTimeoutError) -> JSONResponse:
    """Return a CORS-enabled response without exposing database diagnostics."""
    return JSONResponse(
        status_code=503,
        content={"detail": {"code": "DATABASE_UNAVAILABLE", "message": "The database is temporarily unavailable"}},
    )


app.include_router(health.router)
app.include_router(auth_router)
app.include_router(organizer_profiles.router)
app.include_router(events.router)
app.include_router(tickets.router)
app.include_router(staff.router)
app.include_router(check_ins.router)
app.include_router(attendance.router)
