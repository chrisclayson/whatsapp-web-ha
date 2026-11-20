"""Binary sensors for WhatsApp Web."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import STATE_CONNECTED
from .coordinator import WhatsAppCoordinator
from .entity import WhatsAppEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the binary sensors."""
    coordinator: WhatsAppCoordinator = entry.runtime_data.coordinator
    async_add_entities(
        [
            WhatsAppConnectedSensor(
                coordinator, entry, entry.unique_id or entry.entry_id
            )
        ]
    )


class WhatsAppConnectedSensor(WhatsAppEntity, BinarySensorEntity):
    """Whether the bridge is connected to WhatsApp."""

    _attr_name = "Connection"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    def __init__(
        self,
        coordinator: WhatsAppCoordinator,
        entry: ConfigEntry,
        identifier: str,
    ) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{identifier}_connected"

    @property
    def is_on(self) -> bool:
        return self._data.get("status") == STATE_CONNECTED

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self._data
        me = data.get("me") or {}
        return {
            "status": data.get("status"),
            "account": me.get("id"),
            "account_name": me.get("name"),
            "connected_at": data.get("connected_at"),
            "last_error": data.get("last_error"),
            "bridge_version": data.get("version"),
        }
