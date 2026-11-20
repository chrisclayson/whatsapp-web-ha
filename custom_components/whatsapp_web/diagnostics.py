"""Diagnostics support for WhatsApp Web."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_URL


def _mask(value: str | None) -> str | None:
    if not value:
        return value
    digits = "".join(char for char in value if char.isdigit())
    if len(digits) < 4:
        return "…"
    return f"…{digits[-4:]}"


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Return non-sensitive diagnostics."""
    runtime = entry.runtime_data
    state = await runtime.client.get_state()
    me = state.get("me") or {}
    chats = state.get("chats") or []

    return {
        "entry": {
            "title": entry.title,
            "unique_id": entry.unique_id,
            "options": dict(entry.options),
            "bridge_url": entry.data[CONF_URL],
        },
        "bridge": {
            "version": state.get("version"),
            "status": state.get("status"),
            "instance_id": state.get("instance_id"),
            "last_error": state.get("last_error"),
            "connected_at": state.get("connected_at"),
        },
        "account": {
            "id": _mask(me.get("id")),
            "name": me.get("name"),
        },
        "unread": {
            "total": (state.get("unread") or {}).get("total"),
            "chats_with_unread": [
                {
                    "name": chat.get("name"),
                    "unread": chat.get("unread"),
                    "is_group": chat.get("is_group"),
                }
                for chat in chats
                if int(chat.get("unread") or 0) > 0
            ],
        },
        "chats_known": len(chats),
    }
