from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.auth.router import router as auth_router
from app.core.config import get_settings
from app.routers import events, health, organizer_profiles

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version=__version__,
    description=(
        "Backend of the Palantir event-ticketing platform (CSCI 361). "
        "Current scope: authentication, role-based access control, organizer profiles and events."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth_router)
app.include_router(organizer_profiles.router)
app.include_router(events.router)
