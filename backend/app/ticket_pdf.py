"""The printable ticket: one A4 page with the event, the holder and the ticket QR.

The QR encodes exactly ``ticket.qr_payload``, the same string the website shows and the scanner sends, so
the printed page and the screen are one ticket. Everything is drawn in black on white as vector shapes,
which survives grayscale printing.
"""
from datetime import timedelta, timezone
from pathlib import Path

import qrcode
from fpdf import FPDF
from qrcode.constants import ERROR_CORRECT_M

from app.models import Ticket, User

FONT_PATH = Path(__file__).parent / "assets" / "fonts" / "DejaVuSans.ttf"
FONT = "DejaVuSans"
# Event times are stored in UTC. Tickets print them in the venue's time zone, UTC+5 across Kazakhstan.
VENUE_UTC_OFFSET = timezone(timedelta(hours=5))
VENUE_UTC_LABEL = "UTC+5"

PAGE_MARGIN_MM = 20
QR_SIZE_MM = 90  # the code itself, without the quiet zone
QUIET_ZONE_MODULES = 4  # the minimum the QR standard asks for; the website uses the same
# Neighbouring rectangles overlap by this much. Without it some renderers leave a hairline of white between
# two rows of modules, which is enough to stop a scanner from reading the code.
MODULE_OVERLAP_MM = 0.05
MONTHS = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]


def qr_matrix(payload: str) -> list[list[bool]]:
    """Dark modules of the QR for ``payload``, without a border. Same error correction as the website (M)."""
    code = qrcode.QRCode(error_correction=ERROR_CORRECT_M, border=0)
    code.add_data(payload)
    code.make(fit=True)
    return code.get_matrix()


def _event_time(ticket: Ticket) -> str:
    moment = ticket.event.date
    if moment.tzinfo is None:  # SQLite returns naive datetimes; they are UTC
        moment = moment.replace(tzinfo=timezone.utc)
    local = moment.astimezone(VENUE_UTC_OFFSET)
    return f"{local.day} {MONTHS[local.month - 1]} {local.year}, {local:%H:%M} ({VENUE_UTC_LABEL})"


def build_ticket_pdf(ticket: Ticket, attendee: User) -> bytes:
    pdf = FPDF(orientation="portrait", unit="mm", format="A4")
    pdf.set_auto_page_break(False)
    pdf.set_margins(PAGE_MARGIN_MM, PAGE_MARGIN_MM, PAGE_MARGIN_MM)
    pdf.set_title(f"BiletFlow ticket {ticket.id}")
    pdf.set_creator("BiletFlow")
    pdf.add_font(FONT, fname=str(FONT_PATH))
    pdf.add_page()
    pdf.set_text_color(0)
    width = pdf.w - 2 * PAGE_MARGIN_MM

    def line(text: str, size: int, gap: float = 3) -> None:
        pdf.set_font(FONT, size=size)
        pdf.multi_cell(width, size * 0.5, text, align="C", new_x="LMARGIN", new_y="NEXT")
        pdf.ln(gap)

    line("BiletFlow · Билет", 14, gap=6)
    line(ticket.event.title, 24, gap=5)
    line(_event_time(ticket), 14)
    line(ticket.event.location, 14, gap=8)

    matrix = qr_matrix(ticket.qr_payload)
    module = QR_SIZE_MM / len(matrix)
    quiet = QUIET_ZONE_MODULES * module
    left = (pdf.w - QR_SIZE_MM) / 2
    top = pdf.get_y() + quiet
    pdf.set_fill_color(0)
    for row_index, row in enumerate(matrix):
        start = None
        for column in range(len(row) + 1):  # one rectangle per run of dark modules keeps the file small
            dark = column < len(row) and row[column]
            if dark and start is None:
                start = column
            elif not dark and start is not None:
                pdf.rect(
                    left + start * module, top + row_index * module,
                    (column - start) * module + MODULE_OVERLAP_MM, module + MODULE_OVERLAP_MM, style="F",
                )
                start = None
    pdf.set_y(top + QR_SIZE_MM + quiet + 6)

    line(attendee.full_name, 16)
    line(f"Билет № {ticket.id}", 12, gap=8)
    line("Покажите этот QR-код на входе. Билет действителен на один вход.", 11, gap=2)
    line("Распечатанный билет и билет на экране — один и тот же билет.", 11)
    return bytes(pdf.output())
