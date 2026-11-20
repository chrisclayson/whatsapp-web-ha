"""Shared entity helpers."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_URL, DOMAIN
from .coordinator import WhatsAppCoordinator


def build_device_info(
    entry: ConfigEntry, data: dict[str, Any]
) -> DeviceInfo:
    """Build device info for the linked WhatsApp account."""
    me = data.get("me") or {}
    name = me.get("name") or entry.title or "WhatsApp"
    version = data.get("version")
    return DeviceInfo(
        identifiers={(DOMAIN, entry.unique_id or entry.entry_id)},
        name=name,
        manufacturer="WhatsApp",
        model="Linked device (WhatsApp Web)",
        sw_version=f"bridge {version}" if version else None,
        configuration_url=entry.data.get(CONF_URL),
    )


class WhatsAppEntity(CoordinatorEntity[WhatsAppCoordinator]):
    """Base entity for the integration."""

    _attr_has_entity_name = True

    def __init__(
        self, coordinator: WhatsAppCoordinator, entry: ConfigEntry
    ) -> None:
        super().__init__(coordinator)
        self.entry = entry

    @property
    def device_info(self) -> DeviceInfo:
        return build_device_info(self.entry, self.coordinator.data or {})

    @property
    def _data(self) -> dict[str, Any]:
        return self.coordinator.data or {}
