"""Setup, entity, event and service tests for WhatsApp Web."""

from __future__ import annotations

import asyncio

from homeassistant.const import STATE_OFF, STATE_ON
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp_web.bridge import BridgeClient
from custom_components.whatsapp_web.const import (
    CONF_TOKEN,
    CONF_URL,
    DOMAIN,
    EVENT_MESSAGE,
)

URL = "http://bridge.local:3000"
TOKEN = "test-token-123456789"

STATE = {
    "instance_id": "instance-1",
    "status": "connected",
    "me": {
        "id": "15550000000@s.whatsapp.net",
        "name": "Tester",
        "phone": "15550000000",
    },
    "pairing": None,
    "unread": {"total": 0},
    "chats": [],
    "version": "1.0.0",
    "last_error": None,
    "connected_at": "2026-11-20T12:00:00+00:00",
}

MESSAGE = {
    "sender_username": None,
    "group_name": None,
    "message_id": "m1",
    "chat_id": "15550001111@s.whatsapp.net",
    "chat_name": "Alice",
    "is_group": False,
    "sender_id": "15550001111@s.whatsapp.net",
    "sender_name": "Alice",
    "from_me": False,
    "type": "text",
    "text": "hello from Alice",
    "timestamp": 1700000000,
    "has_media": False,
    "media": None,
    "location": None,
    "mentions": [],
    "quoted_message_id": None,
    "is_forwarded": False,
    "received_at": "2026-11-20T12:00:01+00:00",
    "unread_total": 2,
}

OUTGOING = {
    **MESSAGE,
    "message_id": "m2",
    "sender_name": "Me",
    "from_me": True,
    "text": "my reply",
    "timestamp": 1700000002,
}


async def _setup_entry(
    hass: HomeAssistant, monkeypatch, extra_frames=()
) -> MockConfigEntry:
    async def fake_get_state(self):
        return STATE

    async def fake_listen(self):
        yield {"type": "hello", "data": {**STATE, "unread": {"total": 2}}}
        yield {
            "type": "unread",
            "data": {
                "total": 2,
                "chats": [
                    {
                        "id": "15550001111@s.whatsapp.net",
                        "name": "Alice",
                        "is_group": False,
                        "unread": 2,
                        "timestamp": 1700000000,
                    }
                ],
            },
        }
        yield {"type": "message", "data": MESSAGE}
        for frame in extra_frames:
            yield frame
        await asyncio.Event().wait()

    monkeypatch.setattr(BridgeClient, "get_state", fake_get_state)
    monkeypatch.setattr(BridgeClient, "listen", fake_listen)

    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id="instance-1",
        title="Tester",
        data={CONF_URL: URL, CONF_TOKEN: TOKEN},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await asyncio.sleep(0.05)
    await hass.async_block_till_done()
    return entry


def _state_for(hass: HomeAssistant, domain: str, suffix: str):
    for state in hass.states.async_all(domain):
        if state.entity_id.endswith(suffix):
            return state
    raise AssertionError(f"no {domain} entity ending with {suffix}")


async def test_entities_and_events(hass: HomeAssistant, monkeypatch) -> None:
    events = []

    def record(event):
        events.append(event.data)

    unsub = hass.bus.async_listen(EVENT_MESSAGE, record)
    entry = await _setup_entry(hass, monkeypatch)

    unread = _state_for(hass, "sensor", "_unread_messages")
    assert unread.state == "2"
    assert unread.attributes["connected"] is True
    assert unread.attributes["account"] == "15550000000@s.whatsapp.net"
    assert unread.attributes["last_message"] == "hello from Alice"
    assert unread.attributes["chats"][0]["name"] == "Alice"
    assert unread.attributes["chats"][0]["unread"] == 2

    connected = _state_for(hass, "binary_sensor", "_connection")
    assert connected.state == STATE_ON

    last_message = _state_for(hass, "sensor", "_last_message")
    assert last_message.state == "hello from Alice"
    assert last_message.attributes["chat_name"] == "Alice"

    received = _state_for(hass, "sensor", "_received_messages")
    assert received.state == "1"
    assert len(received.attributes["messages"]) == 1
    assert received.attributes["messages"][0]["text"] == "hello from Alice"
    assert received.attributes["messages"][0]["from_me"] is False

    message_event = _state_for(hass, "event", "_message")
    assert message_event.attributes["event_type"] == "message_received"
    assert message_event.attributes["text"] == "hello from Alice"
    assert message_event.attributes["sender_name"] == "Alice"
    assert message_event.attributes["group_name"] is None

    assert len(events) == 1
    assert events[0]["text"] == "hello from Alice"
    assert events[0]["chat_name"] == "Alice"
    assert events[0]["entry_id"] == entry.entry_id

    unsub()
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def test_service_delegates_to_bridge(
    hass: HomeAssistant, monkeypatch
) -> None:
    calls = []

    async def fake_send(self, to, message):
        calls.append((to, message))
        return {"message_id": "m2", "chat_id": to, "timestamp": 1}

    monkeypatch.setattr(BridgeClient, "send_message", fake_send)
    entry = await _setup_entry(hass, monkeypatch)

    response = await hass.services.async_call(
        DOMAIN,
        "send_message",
        {"to": "15550001111", "message": "hi"},
        blocking=True,
        return_response=True,
    )
    assert calls == [("15550001111", "hi")]
    assert response["message_id"] == "m2"

    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def test_disconnected_state(
    hass: HomeAssistant, monkeypatch
) -> None:
    async def fake_get_state(self):
        return {**STATE, "status": "disconnected", "me": None}

    async def fake_listen(self):
        yield {"type": "hello", "data": {**STATE, "status": "disconnected"}}
        await asyncio.Event().wait()

    monkeypatch.setattr(BridgeClient, "get_state", fake_get_state)
    monkeypatch.setattr(BridgeClient, "listen", fake_listen)

    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id="instance-1",
        title="Tester",
        data={CONF_URL: URL, CONF_TOKEN: TOKEN},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await asyncio.sleep(0.05)

    connected = _state_for(hass, "binary_sensor", "_connection")
    assert connected.state == STATE_OFF
    assert connected.attributes["status"] == "disconnected"

    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def test_received_buffer_excludes_outgoing(
    hass: HomeAssistant, monkeypatch
) -> None:
    events = []

    def record(event):
        events.append(event.data)

    unsub = hass.bus.async_listen(EVENT_MESSAGE, record)
    entry = await _setup_entry(
        hass,
        monkeypatch,
        extra_frames=({"type": "message", "data": OUTGOING},),
    )

    # Prove the outgoing frame was processed before checking the buffer.
    last_message = _state_for(hass, "sensor", "_last_message")
    assert last_message.state == "my reply"

    received = _state_for(hass, "sensor", "_received_messages")
    assert received.state == "1"
    assert [m["text"] for m in received.attributes["messages"]] == [
        "hello from Alice"
    ]
    assert all(not m["from_me"] for m in received.attributes["messages"])

    # Outgoing events stay off by default.
    assert [event["text"] for event in events] == ["hello from Alice"]

    unsub()
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
