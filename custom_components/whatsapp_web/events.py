"""Payload helpers for Home Assistant events."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


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

    return {
        "entry_id": entry_id,
        "instance_id": instance_id,
        "message_id": message.get("message_id"),
        "chat_id": message.get("chat_id"),
        "chat_name": message.get("chat_name"),
        "is_group": bool(message.get("is_group")),
        "sender_id": message.get("sender_id"),
        "sender_name": message.get("sender_name"),
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
