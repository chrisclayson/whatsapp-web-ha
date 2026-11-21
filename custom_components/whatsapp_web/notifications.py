"""Notifications for received WhatsApp messages."""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_NOTIFY_SERVICE, DOMAIN
from .notification_text import notification_content, parse_notify_service

_LOGGER = logging.getLogger(__name__)

async def async_notify(
    hass: HomeAssistant, entry: ConfigEntry, payload: dict[str, Any]
) -> None:
    """Send a persistent notification or call the configured notify service."""
    title, message = notification_content(payload)
    service = parse_notify_service(entry.options.get(CONF_NOTIFY_SERVICE))

    if service is not None:
        domain, name = service
        if hass.services.has_service(domain, name):
            try:
                await hass.services.async_call(
                    domain,
                    name,
                    {"title": title, "message": message},
                    blocking=False,
                )
                return
            except Exception:
                _LOGGER.exception(
                    "Could not call notification service %s.%s", domain, name
                )
        else:
            _LOGGER.warning(
                "Notification service %s.%s is not available; "
                "using a persistent notification",
                domain,
                name,
            )

    chat_id = str(payload.get("chat_id") or entry.entry_id)
    digest = hashlib.sha1(chat_id.encode(), usedforsecurity=False).hexdigest()[:12]
    persistent_notification.async_create(
        hass,
        message,
        title=title,
        notification_id=f"{DOMAIN}_{entry.entry_id}_{digest}",
    )
