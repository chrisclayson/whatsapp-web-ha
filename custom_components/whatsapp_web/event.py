"""Event entity for incoming WhatsApp messages."""

from __future__ import annotations

from typing import Any, ClassVar

from homeassistant.components.event import EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import (
    EVENT_TYPE_MESSAGE_RECEIVED,
    EVENT_TYPE_MESSAGE_SENT,
    message_signal,
)
from .coordinator import WhatsAppCoordinator
from .entity import build_device_info


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the message event entity."""
    coordinator: WhatsAppCoordinator = entry.runtime_data.coordinator
    async_add_entities(
        [
            WhatsAppMessageEvent(
                coordinator, entry, entry.unique_id or entry.entry_id
            )
        ]
    )


class WhatsAppMessageEvent(EventEntity):
    """Fires an event for every message seen by the linked device.

    Use this entity as an automation trigger instead of a bus event when you
    prefer the UI trigger editor. The full payload is available both as event
    attributes and through the ``whatsapp_web_message`` bus event.
    """

    _attr_has_entity_name = True
    _attr_name = "Message"
    _attr_icon = "mdi:whatsapp"
    _attr_event_types: ClassVar[list[str]] = [
        EVENT_TYPE_MESSAGE_RECEIVED,
        EVENT_TYPE_MESSAGE_SENT,
    ]

    def __init__(
        self,
        coordinator: WhatsAppCoordinator,
        entry: ConfigEntry,
        identifier: str,
    ) -> None:
        self.coordinator = coordinator
        self.entry = entry
        self._attr_unique_id = f"{identifier}_message"

    @property
    def device_info(self):
        return build_device_info(self.entry, self.coordinator.data or {})

    @property
    def available(self) -> bool:
        return self.coordinator.last_update_success

    async def async_added_to_hass(self) -> None:
        """Subscribe to message pushes."""
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                message_signal(self.entry.entry_id),
                self._handle_message,
            )
        )

    @callback
    def _handle_message(self, payload: dict[str, Any]) -> None:
        event_type = (
            EVENT_TYPE_MESSAGE_SENT
            if payload.get("from_me")
            else EVENT_TYPE_MESSAGE_RECEIVED
        )
        attributes = {
            key: value
            for key, value in payload.items()
            if key
            in {
                "message_id",
                "chat_id",
                "chat_name",
                "is_group",
                "sender_id",
                "sender_name",
                "type",
                "text",
                "timestamp",
                "timestamp_epoch",
                "has_media",
                "media",
                "location",
                "mentions",
                "quoted_message_id",
                "is_forwarded",
                "unread_total",
            }
        }
        self._trigger_event(event_type, attributes)
        self.async_write_ha_state()
