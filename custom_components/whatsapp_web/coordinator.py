"""Coordinator for the WhatsApp Web integration."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .bridge import BridgeAuthError, BridgeClient, BridgeError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


class WhatsAppCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Keeps bridge state in sync and gives entities a common update path."""

    config_entry: ConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: BridgeClient,
        update_interval: int,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN} {entry.title}",
            update_interval=timedelta(seconds=update_interval),
        )
        self.client = client

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            return await self.client.get_state()
        except BridgeAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except BridgeError as err:
            raise UpdateFailed(str(err)) from err
