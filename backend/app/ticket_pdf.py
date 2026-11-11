"""The printable ticket: one A4 page with the event, the holder and the ticket QR.

The QR encodes exactly ``ticket.qr_payload``, the same string the website shows and the scanner sends, so
the printed page and the screen are one ticket. Everything is drawn in black on white as vector shapes,
which survives grayscale printing.
"""
from dataclasses import dataclass
from datetime import timedelta, timezone
from pathlib import Path

import qrcode
from fpdf import FPDF
from qrcode.constants import ERROR_CORRECT_M

from app.models import Ticket, User
from app.ticket_type_name import TICKET_TYPE_NAME_DISPLAY_LINES

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


@dataclass(frozen=True)
class _TextBlock:
    text: str
    font_size: int
    line_height: float
    gap: float
    height: float


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

    def measure(text: str, size: int, gap: float, *, compact: bool = False,
                max_lines: int | None = None, reserve_lines: bool = False) -> _TextBlock:
        pdf.set_font(FONT, size=size)
        height = size * (0.42 if compact else 0.5)
        if max_lines is not None:
            text = " ".join(text.split())
        lines = pdf.multi_cell(width, height, text, align="C", dry_run=True, output="LINES")
        if max_lines is not None and len(lines) > max_lines:
            lines = lines[:max_lines]
            last = lines[-1].rstrip()
            while pdf.get_string_width(last + "…") > width - 2 * pdf.c_margin:
                # Prefer a whole word. An oversized single word can be broken.
                last = last.rsplit(" ", 1)[0] if " " in last else last[:-1]
            lines[-1] = last + "…"
            text = "\n".join(lines)
        line_count = max_lines if reserve_lines and max_lines is not None else len(lines)
        return _TextBlock(text, size, height, gap, line_count * height + gap)

    def draw(blocks: list[_TextBlock]) -> None:
        for block in blocks:
            pdf.set_font(FONT, size=block.font_size)
            pdf.multi_cell(width, block.line_height, block.text, align="C", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(block.gap)

    def header(compact: bool = False) -> list[_TextBlock]:
        return [
            measure("BiletFlow · Билет", 14, 6),
            measure(ticket.event.title, 20 if compact else 24, 5, max_lines=3 if compact else None),
            measure(_event_time(ticket), 14, 3),
            measure(ticket.event.location, 12 if compact else 14, 8, max_lines=2 if compact else None),
        ]

    def footer(compact: bool = False) -> list[_TextBlock]:
        blocks = [
            measure(attendee.full_name, 11 if compact else 16, 1 if compact else 3,
                    compact=compact, max_lines=1 if compact else None),
            measure(f"Билет № {ticket.id}", 10 if compact else 12, 1 if compact else 8, compact=compact),
        ]
        ticket_type = getattr(ticket, "ticket_type", None)
        if ticket_type is not None:
            blocks.append(measure(f"Тип билета: {ticket_type.name}", 11 if compact else 12, 1 if compact else 3,
                                  compact=compact, max_lines=TICKET_TYPE_NAME_DISPLAY_LINES, reserve_lines=compact))
        blocks.extend([
            measure("Покажите этот QR-код на входе. Билет действителен на один вход.",
                    9 if compact else 11, 1 if compact else 2, compact=compact),
            measure("Распечатанный билет и билет на экране — один и тот же билет.",
                    9 if compact else 11, 0, compact=compact),
        ])
        return blocks

    matrix = qr_matrix(ticket.qr_payload)
    module = QR_SIZE_MM / len(matrix)
    quiet = QUIET_ZONE_MODULES * module
    qr_block_height = QR_SIZE_MM + 2 * quiet + 6
    text_height = pdf.h - 2 * PAGE_MARGIN_MM - qr_block_height
    above, below = header(), footer()
    if sum(block.height for block in above + below) > text_height:
        # Keep the QR anchor by compacting the footer first, reserving two type lines.
        below = footer(compact=True)
        if sum(block.height for block in above + below) > text_height:
            # Exceptionally long event fields can crowd the QR even before the type is added.
            above = header(compact=True)

    draw(above)
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

    draw(below)
    return bytes(pdf.output())
