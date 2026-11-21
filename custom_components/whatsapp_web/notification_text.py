"""Pure text helpers for WhatsApp notifications.

Kept free of Home Assistant imports so they can be unit tested directly.
"""

from __future__ import annotations

from typing import Any

TYPE_LABELS = {
    "image": "Photo",
    "video": "Video",
    "audio": "Audio",
    "voice": "Voice message",
    "document": "Document",
    "sticker": "Sticker",
    "location": "Location",
    "contact": "Contact",
    "poll": "Poll",
    "reaction": "Reaction",
    "group_invite": "Group invite",
}


def parse_notify_service(value: Any) -> tuple[str, str] | None:
    """Parse ``notify.mobile_app_phone`` or a bare service name."""
    text = str(value or "").strip()
    if not text:
        return None
    domain, separator, service = text.partition(".")
    if not separator:
        domain, service = "notify", text
    if not domain or not service:
        return None
    return domain, service


def notification_content(payload: dict[str, Any]) -> tuple[str, str]:
    """Build the title and body, preserving emoji and message text."""
    sender = str(payload.get("sender_name") or "unknown")
    is_group = bool(payload.get("is_group"))
    group = (
        str(payload.get("group_name") or "unknown") if is_group else None
    )

    if is_group:
        title = f"WhatsApp: {group}"
        author = f"{sender} ({group})"
    else:
        title = f"WhatsApp: {sender}"
        author = sender

    text = str(payload.get("text") or "").strip()
    if not text:
        label = TYPE_LABELS.get(payload.get("type"), "message")
        text = f"[{label}]"

    return title, f"{author}:\n{text}"
