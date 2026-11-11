"""GET /tickets/{id}/pdf: the printable ticket carries the same QR as the screen."""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app import ticket_pdf
from app.routers import tickets as tickets_router
from app.schemas.ticket_type import TicketTypeCreate


def detail_code(response):
    return response.json()["detail"]["code"]


@pytest.fixture()
def setup(client, login_as, create_user, auth_header, new_event):
    _, owner = login_as("owner@example.com", "organizer")
    create_user("attendee@example.com", full_name="Әлия Нұрланқызы")
    attendee = auth_header("attendee@example.com")
    event = new_event(owner, title="Клубтар жәрмеңкесі", location="Orange Hall, Астана")
    ticket = client.post(f"/events/{event['id']}/tickets", headers=attendee).json()
    return {"owner": owner, "attendee": attendee, "event": event, "ticket": ticket}


@pytest.fixture()
def drawn(monkeypatch):
    """Record what the PDF builder is asked to draw, and still draw it."""
    calls = []
    real = ticket_pdf.build_ticket_pdf

    def recording(ticket, attendee):
        calls.append(SimpleNamespace(
            ticket_id=ticket.id, qr_payload=ticket.qr_payload, title=ticket.event.title, name=attendee.full_name,
        ))
        return real(ticket, attendee)

    monkeypatch.setattr(tickets_router, "build_ticket_pdf", recording)
    return calls


def test_attendee_downloads_one_a4_pdf_with_their_own_ticket(client, setup, drawn, monkeypatch):
    labels = []
    multi_cell = ticket_pdf.FPDF.multi_cell

    def record_label(pdf, w, h, text, **kwargs):
        labels.append(text)
        return multi_cell(pdf, w, h, text, **kwargs)

    monkeypatch.setattr(ticket_pdf.FPDF, "multi_cell", record_label)
    response = client.get(f"/tickets/{setup['ticket']['id']}/pdf", headers=setup["attendee"])
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == f'attachment; filename="biletflow-ticket-{setup["ticket"]["id"]}.pdf"'
    assert "no-store" in response.headers["cache-control"]
    assert response.content.startswith(b"%PDF-") and response.content.rstrip().endswith(b"%%EOF")
    assert response.content.count(b"/Type /Page\n") == 1
    assert b"/MediaBox [0 0 595.28 841.89]" in response.content  # A4 in points

    assert len(drawn) == 1
    assert drawn[0].ticket_id == setup["ticket"]["id"]
    assert drawn[0].qr_payload == setup["ticket"]["qr_payload"]  # the exact string the screen QR encodes
    assert (drawn[0].title, drawn[0].name) == ("Клубтар жәрмеңкесі", "Әлия Нұрланқызы")
    assert f"Тип билета: {setup['ticket']['ticket_type']['name']}" in labels


def test_downloading_changes_nothing_about_the_ticket(client, setup):
    before = client.get(f"/tickets/{setup['ticket']['id']}", headers=setup["attendee"]).json()
    for _ in range(2):
        assert client.get(f"/tickets/{setup['ticket']['id']}/pdf", headers=setup["attendee"]).status_code == 200
    after = client.get(f"/tickets/{setup['ticket']['id']}", headers=setup["attendee"]).json()
    assert after == before
    assert (after["id"], after["qr_payload"]) == (setup["ticket"]["id"], setup["ticket"]["qr_payload"])


def test_only_the_holder_and_admins_get_the_pdf(client, login_as, setup, drawn):
    _, stranger = login_as("stranger@example.com")
    _, admin = login_as("admin@example.com", "admin")
    path = f"/tickets/{setup['ticket']['id']}/pdf"
    for headers in (stranger, setup["owner"]):  # the organizer scans tickets but does not hold this one
        response = client.get(path, headers=headers)
        assert (response.status_code, detail_code(response)) == (404, "TICKET_NOT_FOUND")
    assert client.get(path).status_code == 401
    assert client.get("/tickets/99999/pdf", headers=setup["attendee"]).status_code == 404
    assert drawn == []
    assert client.get(path, headers=admin).status_code == 200


@pytest.mark.parametrize(("action", "actor", "code"), [
    ("cancel", "attendee", "TICKET_CANCELLED"),
    ("refund", "owner", "TICKET_REFUNDED"),
])
def test_a_closed_ticket_is_not_printed(client, setup, drawn, action, actor, code):
    assert client.post(f"/tickets/{setup['ticket']['id']}/{action}", headers=setup[actor]).status_code == 200
    response = client.get(f"/tickets/{setup['ticket']['id']}/pdf", headers=setup["attendee"])
    assert (response.status_code, detail_code(response)) == (409, code)
    assert drawn == []


def test_a_cancelled_events_ticket_is_not_printed_but_a_used_ticket_is(client, setup, drawn):
    path = f"/tickets/{setup['ticket']['id']}/pdf"
    scan = {"qr_payload": setup["ticket"]["qr_payload"], "request_id": str(uuid.uuid4())}
    assert client.post(f"/events/{setup['event']['id']}/check-in", json=scan, headers=setup["owner"]).status_code == 200
    assert client.get(path, headers=setup["attendee"]).status_code == 200

    client.post(f"/events/{setup['event']['id']}/cancel", headers=setup["owner"])
    response = client.get(path, headers=setup["attendee"])
    assert (response.status_code, detail_code(response)) == (409, "EVENT_CANCELLED")
    assert len(drawn) == 1


# ------------------------------------------------------------------ the drawing itself
def test_qr_matrix_is_a_square_code_without_a_border_and_depends_only_on_the_payload():
    payload = "biletflow:ticket:v1:5Gag__SqYl1CxZUyIqIARjkyDLUNNSW6"
    matrix = ticket_pdf.qr_matrix(payload)
    assert len(matrix) >= 21 and all(len(row) == len(matrix) for row in matrix)
    # No quiet zone inside the matrix: the three finder patterns sit in the corners.
    finder_edge = [True] * 7
    assert matrix[0][:7] == finder_edge and matrix[0][-7:] == finder_edge and matrix[-1][:7] == finder_edge
    assert [row[0] for row in matrix[:7]] == finder_edge
    assert matrix == ticket_pdf.qr_matrix(payload)
    assert matrix != ticket_pdf.qr_matrix(payload + "x")


def test_the_page_fits_a_long_title_and_kazakh_letters_and_shows_local_time():
    ticket = SimpleNamespace(
        id=21,
        qr_payload="biletflow:ticket:v1:5Gag__SqYl1CxZUyIqIARjkyDLUNNSW6",
        event=SimpleNamespace(
            title="Өте ұзақ атауы бар студенттік клубтар жәрмеңкесі " * 4,
            date=datetime(2026, 11, 12, 20, 30, tzinfo=timezone.utc),
            location="Назарбаев Университеті, C3 блогы, Қабанбай батыр даңғылы 53, Астана",
        ),
    )
    data = ticket_pdf.build_ticket_pdf(ticket, SimpleNamespace(full_name="Әлия Нұрланқызы Өтеғұлова-Қасымжанова"))
    assert data.startswith(b"%PDF-") and data.count(b"/Type /Page\n") == 1
    assert ticket_pdf._event_time(ticket) == "13 ноября 2026, 01:30 (UTC+5)"  # 20:30 UTC is the next day in UTC+5
    naive = SimpleNamespace(event=SimpleNamespace(date=datetime(2026, 11, 12, 7, 5)))
    assert ticket_pdf._event_time(naive) == "12 ноября 2026, 12:05 (UTC+5)"


@pytest.mark.parametrize("long_header", [False, True], ids=["existing-qr-position", "oversized-header"])
def test_pdf_long_type_wraps_inside_margins_without_moving_qr(monkeypatch, long_header):
    max_length = TicketTypeCreate.model_json_schema()["properties"]["name"]["maxLength"]
    ticket_type = TicketTypeCreate(name="Ш" * max_length, quantity=1)
    ticket = SimpleNamespace(
        id=1,
        qr_payload="biletflow:ticket:v1:synthetic-review",
        ticket_type=ticket_type,
        event=SimpleNamespace(
            title="Ш" * 200 if long_header else ("Билеты " * 14).strip(),
            date=datetime(2030, 7, 15, tzinfo=timezone.utc),
            location="Ш" * 255 if long_header else ("Конференц-зал " * 9).strip(),
        ),
    )
    attendee = SimpleNamespace(full_name="Ш" * 255 if long_header else ("Александров " * 8).strip())
    text_blocks = []
    rectangles = []
    inside_multi_cell = False
    multi_cell = ticket_pdf.FPDF.multi_cell
    rect = ticket_pdf.FPDF.rect

    def record_text(pdf, w, h, text, **kwargs):
        nonlocal inside_multi_cell
        if inside_multi_cell:
            return multi_cell(pdf, w, h, text, **kwargs)
        inside_multi_cell = True
        try:
            x, y = pdf.get_x(), pdf.get_y()
            result = multi_cell(pdf, w, h, text, **kwargs)
            if not kwargs.get("dry_run"):
                text_blocks.append(SimpleNamespace(text=text, left=x, top=y, right=x + w, bottom=pdf.get_y(),
                                                  line_height=h, page_width=pdf.w, page_height=pdf.h))
            return result
        finally:
            inside_multi_cell = False

    def record_qr(pdf, x, y, width, height, **kwargs):
        rectangles.append((x, y, width, height, kwargs["style"]))
        return rect(pdf, x, y, width, height, **kwargs)

    monkeypatch.setattr(ticket_pdf.FPDF, "multi_cell", record_text)
    monkeypatch.setattr(ticket_pdf.FPDF, "rect", record_qr)
    data = ticket_pdf.build_ticket_pdf(ticket, attendee)
    assert data.count(b"/Type /Page\n") == 1
    label = next(block for block in text_blocks if block.text.startswith("Тип билета:"))
    margin = ticket_pdf.PAGE_MARGIN_MM
    assert label.bottom <= label.page_height - margin, label
    assert label.bottom - label.top <= 2 * label.line_height + 0.01
    assert label.text.endswith("…")
    for block in text_blocks:
        assert block.left >= margin - 0.01 and block.right <= block.page_width - margin + 0.01, block
        assert block.top >= margin - 0.01 and block.bottom <= block.page_height - margin + 0.01, block

    module = ticket_pdf.QR_SIZE_MM / len(ticket_pdf.qr_matrix(ticket.qr_payload))
    quiet = ticket_pdf.QUIET_ZONE_MODULES * module
    top = min(y for _, y, _, _, _ in rectangles)
    if not long_header:
        assert top == pytest.approx(125 + quiet)  # QR anchor before this fix for the same event header
    left = min(x for x, _, _, _, _ in rectangles)
    right = max(x + width for x, _, width, _, _ in rectangles)
    bottom = max(y + height for _, y, _, height, _ in rectangles)
    assert (left + right - ticket_pdf.MODULE_OVERLAP_MM) / 2 == pytest.approx(label.page_width / 2)
    assert right - left == pytest.approx(ticket_pdf.QR_SIZE_MM + ticket_pdf.MODULE_OVERLAP_MM)
    assert bottom - top == pytest.approx(ticket_pdf.QR_SIZE_MM + ticket_pdf.MODULE_OVERLAP_MM)
    assert top - quiet >= margin and bottom + quiet <= label.page_height - margin
    assert all(style == "F" for _, _, _, _, style in rectangles)
    original_rectangles = rectangles.copy()
    rectangles.clear()
    ticket.ticket_type = TicketTypeCreate(name="Партер", quantity=1)
    ticket_pdf.build_ticket_pdf(ticket, attendee)
    assert rectangles == original_rectangles


def test_the_bundled_font_has_the_russian_and_kazakh_letters():
    from fontTools.ttLib import TTFont

    cmap = TTFont(str(ticket_pdf.FONT_PATH)).getBestCmap()
    letters = "АаЯяЁёӘәҒғҚқҢңӨөҰұҮүҺһІі№·"
    assert [letter for letter in letters if ord(letter) not in cmap] == []
