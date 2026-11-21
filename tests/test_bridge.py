"""Tests for the WhatsApp Web bridge client and payload helpers."""

from __future__ import annotations

import json

import aiohttp
import pytest
from aiohttp import web
from bridge import (
    BridgeAuthError,
    BridgeClient,
    BridgeConnectionError,
    BridgeError,
)
from events import build_message_payload

TOKEN = "test-token-123456"


@pytest.fixture
async def bridge_server(aiohttp_server):
    app = web.Application()

    async def state(request):
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return web.json_response(
                {"error": {"code": "unauthorized", "message": "bad token"}},
                status=401,
            )
        return web.json_response(
            {
                "instance_id": "instance-1",
                "status": "connected",
                "unread": {"total": 2},
                "chats": [],
            }
        )

    async def send(request):
        body = await request.json()
        return web.json_response(
            {"message_id": "m1", "chat_id": body["to"], "timestamp": 1}
        )

    async def fail(request):
        return web.json_response(
            {"error": {"code": "not_connected", "message": "not connected"}},
            status=409,
        )

    async def ws_handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({"type": "hello", "data": {"status": "connected"}})
        await ws.send_json({"type": "unread", "data": {"total": 3, "chats": []}})
        await ws.close()
        return ws

    app.router.add_get("/api/state", state)
    app.router.add_post("/api/send", send)
    app.router.add_post("/api/fail", fail)
    app.router.add_get("/ws", ws_handler)
    return await aiohttp_server(app)


async def test_state_requires_the_right_token(bridge_server):
    session = aiohttp.ClientSession()
    try:
        client = BridgeClient(
            session, str(bridge_server.make_url("")), TOKEN
        )
        state = await client.get_state()
        assert state["instance_id"] == "instance-1"
        assert state["unread"]["total"] == 2

        bad = BridgeClient(
            session, str(bridge_server.make_url("")), "wrong-token"
        )
        with pytest.raises(BridgeAuthError):
            await bad.get_state()
    finally:
        await session.close()


async def test_bridge_errors_are_mapped(bridge_server):
    session = aiohttp.ClientSession()
    try:
        client = BridgeClient(session, str(bridge_server.make_url("")), TOKEN)
        with pytest.raises(BridgeError) as caught:
            await client._request("POST", "/api/fail")
        assert caught.value.status == 409
        assert caught.value.code == "not_connected"
    finally:
        await session.close()


async def test_connection_errors_are_wrapped():
    session = aiohttp.ClientSession()
    try:
        client = BridgeClient(session, "http://127.0.0.1:1", TOKEN, timeout=2)
        with pytest.raises(BridgeConnectionError):
            await client.get_state()
    finally:
        await session.close()


async def test_send_payload_and_response(bridge_server):
    session = aiohttp.ClientSession()
    try:
        client = BridgeClient(session, str(bridge_server.make_url("")), TOKEN)
        result = await client.send_message("15551234567", "hello")
        assert result == {
            "message_id": "m1",
            "chat_id": "15551234567",
            "timestamp": 1,
        }
    finally:
        await session.close()


async def test_websocket_frames_are_yielded(bridge_server):
    session = aiohttp.ClientSession()
    try:
        client = BridgeClient(session, str(bridge_server.make_url("")), TOKEN)
        frames = [frame async for frame in client.listen()]
    finally:
        await session.close()

    assert frames[0]["type"] == "hello"
    assert frames[1]["data"]["total"] == 3


async def test_url_normalization():
    session = aiohttp.ClientSession()
    try:
        client = BridgeClient(session, "example.local:3000/", TOKEN)
        assert client.base_url == "http://example.local:3000"
        assert client.ws_url == "ws://example.local:3000/ws"

        https = BridgeClient(session, "https://ha.local/", TOKEN)
        assert https.ws_url == "wss://ha.local/ws"
    finally:
        await session.close()


def test_event_payload_normalization():
    payload = build_message_payload(
        "entry-1",
        "instance-1",
        {
            "message_id": "m1",
            "chat_id": "15551234567@s.whatsapp.net",
            "chat_name": "Alice",
            "is_group": False,
            "sender_id": "15551234567@s.whatsapp.net",
            "sender_name": "Alice",
            "from_me": False,
            "type": "text",
            "text": "hello",
            "timestamp": 1700000000,
            "has_media": False,
            "mentions": ["15550000000@s.whatsapp.net"],
        },
    )

    assert payload["entry_id"] == "entry-1"
    assert payload["timestamp"] == "2023-11-14T22:13:20+00:00"
    assert payload["timestamp_epoch"] == 1700000000
    assert payload["from_me"] is False
    assert payload["media"] is None
    assert payload["mentions"] == ["15550000000@s.whatsapp.net"]
    assert payload["unread_total"] is None
    assert payload["sender_username"] is None
    assert payload["group_name"] is None


def test_event_payload_handles_missing_values():
    payload = build_message_payload("entry-1", None, {"text": None})
    assert payload["text"] == ""
    assert payload["type"] == "unknown"
    assert payload["timestamp"] is None
    assert payload["media"] is None
    assert payload["sender_name"] == "unknown"
    assert payload["chat_name"] == "unknown"
    assert payload["group_name"] is None
    json.dumps(payload)  # must be JSON serializable for the event bus


def test_event_payload_falls_back_to_unknown_names():
    payload = build_message_payload(
        "entry-1",
        "instance-1",
        {
            "chat_id": "120363000000000000@g.us",
            "is_group": True,
            "sender_name": None,
            "group_name": None,
            "text": "hello",
        },
    )
    assert payload["sender_name"] == "unknown"
    assert payload["group_name"] == "unknown"
    assert payload["chat_name"] == "unknown"


def test_event_payload_keeps_group_and_username():
    payload = build_message_payload(
        "entry-1",
        "instance-1",
        {
            "chat_id": "120363000000000000@g.us",
            "chat_id_alt": None,
            "chat_name": "Family",
            "group_name": "Family",
            "is_group": True,
            "sender_id": "15551234567@s.whatsapp.net",
            "sender_name": "Alice",
            "sender_username": "alice.w",
            "text": "hi",
        },
    )
    assert payload["group_name"] == "Family"
    assert payload["sender_name"] == "Alice"
    assert payload["sender_username"] == "alice.w"


def test_event_payload_never_uses_a_phone_number_as_a_name():
    payload = build_message_payload(
        "entry-1",
        "instance-1",
        {
            "chat_id": "15551234567@s.whatsapp.net",
            "chat_name": "+15551234567",
            "sender_name": "15551234567",
            "is_group": False,
        },
    )
    assert payload["sender_name"] == "unknown"
    assert payload["chat_name"] == "unknown"
