"""Service handlers for the WhatsApp Web integration."""

from __future__ import annotations

import logging
from typing import Any, NoReturn

import voluptuous as vol
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .bridge import BridgeAuthError, BridgeError
from .const import (
    ATTR_CHAT,
    ATTR_ENTRY_ID,
    ATTR_MESSAGE,
    ATTR_MESSAGE_IDS,
    ATTR_STATE,
    ATTR_TO,
    DOMAIN,
    SERVICE_MARK_READ,
    SERVICE_SEND_MESSAGE,
    SERVICE_SEND_TYPING,
)

_LOGGER = logging.getLogger(__name__)

ENTRY_FIELD = vol.Optional(ATTR_ENTRY_ID)

SEND_MESSAGE_SCHEMA = vol.Schema(
    {
        ENTRY_FIELD: cv.string,
        vol.Required(ATTR_TO): cv.string,
        vol.Required(ATTR_MESSAGE): cv.string,
    }
)

MARK_READ_SCHEMA = vol.Schema(
    {
        ENTRY_FIELD: cv.string,
        vol.Required(ATTR_CHAT): cv.string,
        vol.Optional(ATTR_MESSAGE_IDS): vol.All(cv.ensure_list, [cv.string]),
    }
)

SEND_TYPING_SCHEMA = vol.Schema(
    {
        ENTRY_FIELD: cv.string,
        vol.Required(ATTR_CHAT): cv.string,
        vol.Optional(ATTR_STATE, default="composing"): vol.In(
            ["composing", "paused"]
        ),
    }
)


def _resolve_runtime(hass: HomeAssistant, entry_id: str | None) -> Any:
    entries = [
        entry
        for entry in hass.config_entries.async_entries(DOMAIN)
        if entry.state is ConfigEntryState.LOADED
    ]
    if entry_id:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN:
            raise ServiceValidationError(
                f"Unknown WhatsApp Web config entry: {entry_id}"
            )
        runtime = getattr(entry, "runtime_data", None)
        if runtime is None:
            raise ServiceValidationError(
                "That WhatsApp Web config entry is not loaded"
            )
        return runtime

    if not entries:
        raise ServiceValidationError("No WhatsApp Web config entry is loaded")
    if len(entries) > 1:
        raise ServiceValidationError(
            "Multiple WhatsApp accounts are configured; pass entry_id"
        )
    runtime = getattr(entries[0], "runtime_data", None)
    if runtime is None:
        raise ServiceValidationError("The WhatsApp Web config entry is not loaded")
    return runtime


def _raise_service_error(err: BridgeError) -> NoReturn:
    if isinstance(err, BridgeAuthError):
        raise ServiceValidationError(
            "The WhatsApp bridge rejected the API token. Reauthenticate the integration."
        ) from err
    raise ServiceValidationError(str(err)) from err


async def _async_send_message(call: ServiceCall) -> dict[str, Any]:
    runtime = _resolve_runtime(call.hass, call.data.get(ATTR_ENTRY_ID))
    try:
        return await runtime.client.send_message(
            call.data[ATTR_TO], call.data[ATTR_MESSAGE]
        )
    except BridgeError as err:
        _raise_service_error(err)


async def _async_mark_read(call: ServiceCall) -> dict[str, Any]:
    runtime = _resolve_runtime(call.hass, call.data.get(ATTR_ENTRY_ID))
    try:
        return await runtime.client.mark_read(
            call.data[ATTR_CHAT], call.data.get(ATTR_MESSAGE_IDS)
        )
    except BridgeError as err:
        _raise_service_error(err)


async def _async_send_typing(call: ServiceCall) -> None:
    runtime = _resolve_runtime(call.hass, call.data.get(ATTR_ENTRY_ID))
    try:
        await runtime.client.send_typing(
            call.data[ATTR_CHAT], call.data.get(ATTR_STATE, "composing")
        )
    except BridgeError as err:
        _raise_service_error(err)


def async_setup_services(hass: HomeAssistant) -> None:
    """Register the integration services once."""
    if hass.services.has_service(DOMAIN, SERVICE_SEND_MESSAGE):
        return

    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_MESSAGE,
        _async_send_message,
        schema=SEND_MESSAGE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_MARK_READ,
        _async_mark_read,
        schema=MARK_READ_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_TYPING,
        _async_send_typing,
        schema=SEND_TYPING_SCHEMA,
    )
