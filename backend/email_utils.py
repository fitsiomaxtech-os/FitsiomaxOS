"""Outbound email, and the one place that knows whether this install can send any.

Read at import rather than per call, which is safe because `database` — imported first by
server.py — is what calls load_dotenv, so the .env is on os.environ before this module is
reached. Changing a credential still needs a restart, which is how every other setting on
this backend behaves.

Two things a caller needs to tell apart, because the fix for each is different and the
person reading the message is usually not the person who can apply it:

    SmtpNotConfigured   no credentials on this server. Nothing is wrong with the request
                        and retrying will never help — somebody has to set SMTP_USER and
                        SMTP_PASSWORD in backend/.env and restart.
    SmtpSendFailed      credentials exist and the send still failed: Gmail refused the
                        app password, the port is blocked, the address bounced. Worth
                        retrying, and worth reading the log line for.

Before this, both arrived as a bare RuntimeError and the actual SMTP error was swallowed
by whoever caught it — so "could not send" was the whole of what anybody knew, on a
failure whose cause is written plainly in the exception.
"""
import logging
import os
import smtplib
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")


class SmtpNotConfigured(RuntimeError):
    """No SMTP_USER/SMTP_PASSWORD on this server — a setup problem, not a send problem."""


class SmtpSendFailed(RuntimeError):
    """Configured, but this particular send did not go out."""


def smtp_configured() -> bool:
    """Whether this backend can send email at all.

    Asked before a screen offers something that depends on email — turning on two-factor,
    say — so the answer arrives as a disabled button with a reason rather than as a red
    toast after the user has committed to the action.
    """
    return bool(SMTP_USER and SMTP_PASSWORD)


def smtp_status() -> dict:
    """What is set, for a human diagnosing a server that will not send.

    The password is reported as a yes/no and never echoed. The host, port and account are
    the three things that are actually wrong when Gmail refuses a login, and none of them
    is a secret.
    """
    return {
        "configured": smtp_configured(),
        "host": SMTP_HOST,
        "port": SMTP_PORT,
        "user": SMTP_USER or None,
        "password_set": bool(SMTP_PASSWORD),
    }


def send_email(to_address: str, subject: str, body: str, attachments=None) -> None:
    """Send plain text, with optional image attachments as (filename, bytes, "image/png")."""
    if not smtp_configured():
        logger.error(
            "Email not sent to %s (%r): SMTP_USER/SMTP_PASSWORD are not set in backend/.env",
            to_address, subject,
        )
        raise SmtpNotConfigured("SMTP_USER/SMTP_PASSWORD are not configured on the backend")

    if attachments:
        message = MIMEMultipart()
        message.attach(MIMEText(body))
        for filename, data, mime in attachments:
            part = MIMEImage(data, _subtype=mime.split("/", 1)[1])
            part.add_header("Content-Disposition", "attachment", filename=filename)
            message.attach(part)
    else:
        message = MIMEText(body)
    message["Subject"] = subject
    message["From"] = SMTP_USER
    message["To"] = to_address

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_USER, [to_address], message.as_string())
    except Exception as exc:
        # The whole reason this except exists. Every caller turns a failure here into a
        # sentence for a user, and without this line the actual cause — "535 Username and
        # Password not accepted", a timeout on port 587 — reaches nobody at all.
        logger.exception(
            "Email failed to %s (%r) via %s:%s as %s — %s",
            to_address, subject, SMTP_HOST, SMTP_PORT, SMTP_USER, exc,
        )
        raise SmtpSendFailed(str(exc)) from exc

    logger.info("Email sent to %s (%r)", to_address, subject)
