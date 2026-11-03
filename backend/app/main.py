import json

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from sqlalchemy.exc import DataError
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.auth.router import router as auth_router
from app.core.config import get_settings
from app.routers import check_ins, events, health, organizer_profiles, staff, tickets

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
    """FastAPI's default 422 body, ASCII-escaped: echoed input may hold lone surrogates that UTF-8 cannot encode."""
    body = json.dumps({"detail": jsonable_encoder(exc.errors())}, ensure_ascii=True)
    return Response(body, status_code=422, media_type="application/json")


@app.exception_handler(DataError)
def reject_unstorable_input(request: Request, exc: DataError) -> JSONResponse:
    """PostgreSQL refused a value Pydantic let through (NUL characters, ids beyond its integer range)."""
    return JSONResponse(
        status_code=422,
        content={"detail": {"code": "INVALID_INPUT", "message": "The request contains a value that cannot be stored"}},
    )


app.include_router(health.router)
app.include_router(auth_router)
app.include_router(organizer_profiles.router)
app.include_router(events.router)
app.include_router(tickets.router)
app.include_router(staff.router)
app.include_router(check_ins.router)
