"""Sensors for WhatsApp Web."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import (
    MAX_TEXT_LENGTH,
    STATE_CONNECTED,
    UNREAD_CHAT_LIMIT,
)
from .coordinator import WhatsAppCoordinator
from .entity import WhatsAppEntity

_LOGGER = logging.getLogger(__name__)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=UTC).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _message_time(message: dict[str, Any]) -> str | None:
    """Return an ISO timestamp for pushed or chat-derived messages."""
    if (epoch := message.get("timestamp_epoch")) is not None:
        return _iso(epoch)
    value = message.get("timestamp")
    if isinstance(value, str):
        return value
    return _iso(value)


def _find_last_message(data: dict[str, Any]) -> dict[str, Any] | None:
    """Return the most recent message, preferring the pushed WS payload."""
    pushed = data.get("last_message")
    if isinstance(pushed, dict) and pushed.get("text") is not None:
        return pushed

    newest: dict[str, Any] | None = None
    newest_ts = -1
    for chat in data.get("chats") or []:
        last = chat.get("last_message")
        if not isinstance(last, dict):
            continue
        timestamp = int(last.get("timestamp") or 0)
        if timestamp > newest_ts:
            newest_ts = timestamp
            newest = {
                **last,
                "chat_id": chat.get("id"),
                "chat_name": chat.get("name"),
            }
    return newest


def _unread_chats(data: dict[str, Any]) -> list[dict[str, Any]]:
    pushed = data.get("unread_chats")
    if isinstance(pushed, list):
        chats = pushed
    else:
        chats = [
            {
                "id": chat.get("id"),
                "name": chat.get("name"),
                "is_group": chat.get("is_group"),
                "unread": chat.get("unread"),
                "timestamp": chat.get("timestamp"),
            }
            for chat in data.get("chats") or []
            if int(chat.get("unread") or 0) > 0
        ]

    result = [
        {
            "id": chat.get("id"),
            "name": chat.get("name"),
            "is_group": bool(chat.get("is_group")),
            "unread": int(chat.get("unread") or 0),
            "last_message_at": _iso(chat.get("timestamp")),
        }
        for chat in chats
        if int(chat.get("unread") or 0) > 0
    ]
    result.sort(
        key=lambda item: (item["unread"], item["last_message_at"] or ""),
        reverse=True,
    )
    return result[:UNREAD_CHAT_LIMIT]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the sensors."""
    coordinator: WhatsAppCoordinator = entry.runtime_data.coordinator
    identifier = entry.unique_id or entry.entry_id
    async_add_entities(
        [
            WhatsAppUnreadSensor(coordinator, entry, identifier),
            WhatsAppLastMessageSensor(coordinator, entry, identifier),
        ]
    )


class WhatsAppUnreadSensor(WhatsAppEntity, SensorEntity):
    """Total number of unread WhatsApp messages."""

    _attr_name = "Unread messages"
    _attr_icon = "mdi:whatsapp"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 0

    def __init__(
        self,
        coordinator: WhatsAppCoordinator,
        entry: ConfigEntry,
        identifier: str,
    ) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{identifier}_unread"

    @property
    def native_value(self) -> int:
        unread = self._data.get("unread") or {}
        try:
            return int(unread.get("total") or 0)
        except (TypeError, ValueError):
            return 0

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self._data
        me = data.get("me") or {}
        last = _find_last_message(data)
        return {
            "chats": _unread_chats(data),
            "connected": data.get("status") == STATE_CONNECTED,
            "account": me.get("id"),
            "account_name": me.get("name"),
            "last_message": (last or {}).get("text"),
            "last_message_at": _message_time(last) if last else None,
            "last_message_chat": (last or {}).get("chat_name"),
        }


class WhatsAppLastMessageSensor(WhatsAppEntity, SensorEntity):
    """Text of the most recent message seen by the linked device."""

    _attr_name = "Last message"
    _attr_icon = "mdi:message-text-outline"

    def __init__(
        self,
        coordinator: WhatsAppCoordinator,
        entry: ConfigEntry,
        identifier: str,
    ) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{identifier}_last_message"

    @property
    def native_value(self) -> str | None:
        message = _find_last_message(self._data)
        if not message:
            return None
        text = str(message.get("text") or "").strip()
        if not text:
            return f"[{message.get('type') or 'message'}]"
        return text[:MAX_TEXT_LENGTH]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        message = _find_last_message(self._data)
        if not message:
            return {}
        return {
            "message_id": message.get("id") or message.get("message_id"),
            "chat_id": message.get("chat_id"),
            "chat_name": message.get("chat_name"),
            "sender_id": message.get("sender_id"),
            "sender_name": message.get("sender_name"),
            "type": message.get("type"),
            "from_me": bool(message.get("from_me")),
            "has_media": bool(message.get("has_media")),
            "timestamp": _message_time(message),
        }
