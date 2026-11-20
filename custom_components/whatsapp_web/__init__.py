"""Set up the WhatsApp Web integration."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .bridge import (
    BridgeAuthError,
    BridgeClient,
    BridgeConnectionError,
    BridgeError,
)
from .const import (
    CONF_FIRE_OUTGOING_EVENTS,
    CONF_POLL_INTERVAL,
    CONF_TOKEN,
    CONF_URL,
    DEFAULT_POLL_INTERVAL,
    DOMAIN,
    EVENT_MESSAGE,
    message_signal,
)
from .coordinator import WhatsAppCoordinator
from .events import build_message_payload
from .services import async_setup_services

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.SENSOR,
    Platform.BINARY_SENSOR,
    Platform.EVENT,
]


@dataclass
class WhatsAppRuntime:
    """Runtime state for one bridge account."""

    client: BridgeClient
    coordinator: WhatsAppCoordinator
    listener: asyncio.Task[None] | None = None
    unread_chats: list[dict[str, Any]] = field(default_factory=list)


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Register services even before an entry is loaded."""
    async_setup_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up WhatsApp Web from a config entry."""
    client = BridgeClient(
        async_get_clientsession(hass),
        entry.data[CONF_URL],
        entry.data[CONF_TOKEN],
    )
    try:
        state = await client.get_state()
    except BridgeAuthError as err:
        raise ConfigEntryAuthFailed(str(err)) from err
    except BridgeConnectionError as err:
        raise ConfigEntryNotReady(str(err)) from err
    except BridgeError as err:
        raise ConfigEntryNotReady(str(err)) from err

    coordinator = WhatsAppCoordinator(
        hass,
        entry,
        client,
        entry.options.get(CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL),
    )
    coordinator.async_set_updated_data(state)

    runtime = WhatsAppRuntime(client=client, coordinator=coordinator)
    runtime.unread_chats = [
        chat for chat in state.get("chats", []) if int(chat.get("unread") or 0) > 0
    ]
    entry.runtime_data = runtime

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    runtime.listener = entry.async_create_background_task(
        hass,
        _listen(hass, entry, runtime),
        f"{DOMAIN} listener {entry.entry_id}",
    )
    async_setup_services(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    runtime: WhatsAppRuntime | None = getattr(entry, "runtime_data", None)
    if runtime and runtime.listener:
        runtime.listener.cancel()
        try:
            await runtime.listener
        except asyncio.CancelledError:
            pass
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _listen(
    hass: HomeAssistant, entry: ConfigEntry, runtime: WhatsAppRuntime
) -> None:
    """Consume the bridge WebSocket and reconnect with backoff."""
    backoff = 1
    while True:
        try:
            async for frame in runtime.client.listen():
                backoff = 1
                _handle_frame(hass, entry, runtime, frame)
        except asyncio.CancelledError:
            raise
        except BridgeAuthError as err:
            _LOGGER.error("WhatsApp bridge authentication failed: %s", err)
            entry.async_start_reauth(hass)
            return
        except BridgeError as err:
            _LOGGER.debug("WhatsApp bridge WebSocket closed: %s", err)
        except Exception:
            _LOGGER.exception("Unexpected error in the WhatsApp listener")

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)

        try:
            state = await runtime.client.get_state()
        except BridgeAuthError as err:
            _LOGGER.error("WhatsApp bridge authentication failed: %s", err)
            entry.async_start_reauth(hass)
            return
        except BridgeError:
            continue
        runtime.unread_chats = [
            chat
            for chat in state.get("chats", [])
            if int(chat.get("unread") or 0) > 0
        ]
        state["unread_chats"] = runtime.unread_chats
        runtime.coordinator.async_set_updated_data(state)


def _handle_frame(
    hass: HomeAssistant,
    entry: ConfigEntry,
    runtime: WhatsAppRuntime,
    frame: dict[str, Any],
) -> None:
    """Apply one WebSocket frame."""
    frame_type = frame.get("type")
    data = frame.get("data") or {}
    coordinator = runtime.coordinator
    state = dict(coordinator.data or {})

    if frame_type == "hello":
        state = data
        runtime.unread_chats = [
            chat
            for chat in state.get("chats", [])
            if int(chat.get("unread") or 0) > 0
        ]
        coordinator.async_set_updated_data(state)
        return

    if frame_type == "connection":
        for key in ("status", "me", "last_error", "connected_at"):
            if key in data:
                state[key] = data[key]
        coordinator.async_set_updated_data(state)
        return

    if frame_type == "pairing":
        state["pairing"] = data
        coordinator.async_set_updated_data(state)
        return

    if frame_type == "unread":
        state["unread"] = {"total": int(data.get("total") or 0)}
        runtime.unread_chats = data.get("chats") or []
        state["unread_chats"] = runtime.unread_chats
        coordinator.async_set_updated_data(state)
        return

    if frame_type == "message":
        payload = build_message_payload(
            entry.entry_id, state.get("instance_id"), data
        )
        state["last_message"] = payload
        coordinator.async_set_updated_data(state)

        if payload["from_me"] and not entry.options.get(
            CONF_FIRE_OUTGOING_EVENTS, False
        ):
            return

        hass.bus.async_fire(EVENT_MESSAGE, payload)
        async_dispatcher_send(
            hass, message_signal(entry.entry_id), payload
        )
        return

    _LOGGER.debug("Ignoring unknown bridge frame type %s", frame_type)
