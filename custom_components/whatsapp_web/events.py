"""Payload helpers for Home Assistant events."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

_PHONE_LIKE = re.compile(r"^\+?\d[\d\s().-]{5,}$")


def _display_name(value: Any, fallback: str = "unknown") -> str:
    """Use a human name, never a phone number, for display fields."""
    if value is None:
        return fallback
    text = str(value).strip()
    if not text or _PHONE_LIKE.match(text):
        return fallback
    return text


def _iso_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=UTC).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def build_message_payload(
    entry_id: str,
    instance_id: str | None,
    message: dict[str, Any],
) -> dict[str, Any]:
    """Normalize a bridge message frame for the HA event bus and event entity."""
    timestamp = message.get("timestamp")
    media = message.get("media")
    location = message.get("location")
    is_group = bool(message.get("is_group"))
    sender_name = _display_name(message.get("sender_name"))
    raw_chat_name = message.get("chat_name")
    if is_group:
        group_name = str(
            message.get("group_name") or raw_chat_name or "unknown"
        )
        chat_name = str(raw_chat_name or group_name)
    else:
        chat_name = _display_name(raw_chat_name, sender_name)
        group_name = None

    return {
        "entry_id": entry_id,
        "instance_id": instance_id,
        "message_id": message.get("message_id"),
        "chat_id": message.get("chat_id"),
        "chat_id_alt": message.get("chat_id_alt"),
        "chat_name": chat_name,
        "group_name": group_name,
        "is_group": is_group,
        "sender_id": message.get("sender_id"),
        "sender_name": sender_name,
        "sender_username": message.get("sender_username"),
        "from_me": bool(message.get("from_me")),
        "type": message.get("type") or "unknown",
        "text": str(message.get("text") or ""),
        "timestamp": _iso_timestamp(timestamp),
        "timestamp_epoch": int(timestamp) if timestamp else None,
        "has_media": bool(message.get("has_media")),
        "media": dict(media) if isinstance(media, dict) else None,
        "location": dict(location) if isinstance(location, dict) else None,
        "mentions": list(message.get("mentions") or []),
        "quoted_message_id": message.get("quoted_message_id"),
        "is_forwarded": bool(message.get("is_forwarded")),
        "received_at": message.get("received_at"),
        "unread_total": message.get("unread_total"),
    }
