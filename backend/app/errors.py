"""Errors that carry a machine-readable code: ``{"detail": {"code": ..., "message": ...}}``.

Clients (the mobile scanner in particular) branch on ``code``; ``message`` is for people.
"""
from fastapi import HTTPException


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, {"code": code, "message": message})
