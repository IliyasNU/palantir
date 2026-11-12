"""Outgoing email (BE-3). Callers schedule ``send_email`` as a background task so SMTP never blocks a request."""
import logging
import smtplib
from email.message import EmailMessage

from app.core.config import get_settings

logger = logging.getLogger(__name__)


def send_email(to: str, subject: str, body: str) -> None:
    settings = get_settings()
    if not settings.smtp_host:
        if settings.environment == "production":
            logger.warning("SMTP_HOST is not set; email %r to %s was not sent", subject, to)
        else:
            logger.warning("Email not sent (no SMTP_HOST)\nTo: %s\nSubject: %s\n\n%s", to, subject, body)
        return

    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
            if settings.smtp_starttls:
                smtp.starttls()
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException):
        logger.exception("Could not send email %r to %s", subject, to)


def _link(path: str, token: str) -> str:
    return f"{get_settings().frontend_url.rstrip('/')}{path}?token={token}"


def verification_email(full_name: str, token: str) -> tuple[str, str]:
    hours = get_settings().email_verify_expire_hours
    return (
        "Подтвердите почту BiletFlow",
        f"Здравствуйте, {full_name}!\n\n"
        f"Чтобы подтвердить адрес почты, откройте ссылку:\n{_link('/verify-email', token)}\n\n"
        f"Ссылка действует {hours} ч. Если вы не регистрировались в BiletFlow, просто удалите это письмо.\n",
    )


def password_reset_email(full_name: str, token: str) -> tuple[str, str]:
    minutes = get_settings().password_reset_expire_minutes
    return (
        "Сброс пароля BiletFlow",
        f"Здравствуйте, {full_name}!\n\n"
        f"Чтобы задать новый пароль, откройте ссылку:\n{_link('/reset-password', token)}\n\n"
        f"Ссылка действует {minutes} мин и работает один раз. После смены пароля все сеансы завершатся.\n"
        "Если вы не запрашивали сброс, просто удалите это письмо: пароль останется прежним.\n",
    )
