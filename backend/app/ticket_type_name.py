"""Name limits shared by ticket types in the API, web and PDF."""
import json
from pathlib import Path

_policy = json.loads((Path(__file__).parent / "assets" / "ticket-type-name.json").read_text(encoding="utf-8"))
TICKET_TYPE_NAME_MAX_LENGTH: int = _policy["maxLength"]
TICKET_TYPE_NAME_DISPLAY_LINES: int = _policy["displayLines"]
