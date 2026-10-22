"""Organizer profile endpoints: create, view and update.

NOTE: the fixed `/me` routes are declared before `/{profile_id}` on purpose.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.dependencies.auth import get_current_user
from app.dependencies.db import DbSession
from app.dependencies.roles import OrganizerUser
from app.models import OrganizerProfile, User
from app.schemas.organizer_profile import (
    OrganizerProfileCreate,
    OrganizerProfileRead,
    OrganizerProfileUpdate,
)

router = APIRouter(prefix="/organizer-profiles", tags=["organizer profiles"])


def _own_profile_or_404(user: User) -> OrganizerProfile:
    if user.organizer_profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organizer profile not found")
    return user.organizer_profile


@router.post("", response_model=OrganizerProfileRead, status_code=status.HTTP_201_CREATED)
def create_profile(payload: OrganizerProfileCreate, db: DbSession, current_user: OrganizerUser):
    """Create the profile of the logged-in organizer (one per organizer)."""
    if current_user.organizer_profile is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "You already have an organizer profile")

    profile = OrganizerProfile(user_id=current_user.id, **payload.model_dump())
    db.add(profile)
    try:
        db.commit()
    except IntegrityError:  # concurrent double-submit
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "You already have an organizer profile")
    db.refresh(profile)
    return profile


@router.get("/me", response_model=OrganizerProfileRead)
def get_my_profile(current_user: OrganizerUser):
    """View the logged-in organizer's own profile."""
    return _own_profile_or_404(current_user)


@router.patch("/me", response_model=OrganizerProfileRead)
@router.put("/me", response_model=OrganizerProfileRead)
def update_my_profile(payload: OrganizerProfileUpdate, db: DbSession, current_user: OrganizerUser):
    """Update the logged-in organizer's profile. Only the fields you send are changed (PUT and PATCH behave the same)."""
    profile = _own_profile_or_404(current_user)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)
    db.commit()
    db.refresh(profile)
    return profile


@router.get(
    "/{profile_id}",
    response_model=OrganizerProfileRead,
    dependencies=[Depends(get_current_user)],
)
def get_profile(profile_id: int, db: DbSession):
    """View any organizer's profile (any logged-in user)."""
    profile = db.get(OrganizerProfile, profile_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organizer profile not found")
    return profile
