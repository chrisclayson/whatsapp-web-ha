"""Config flow tests for WhatsApp Web."""

from __future__ import annotations

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp_web.const import (
    CONF_TOKEN,
    CONF_URL,
    DOMAIN,
)

URL = "http://bridge.local:3000"
TOKEN = "test-token-123456789"

CONNECTED_STATE = {
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

UNPAIRED_STATE = {
    **CONNECTED_STATE,
    "status": "disconnected",
    "me": None,
    "connected_at": None,
}


async def test_user_flow_creates_entry_when_already_paired(
    hass: HomeAssistant, aioclient_mock
) -> None:
    aioclient_mock.get(f"{URL}/api/state", json=CONNECTED_STATE)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: URL, CONF_TOKEN: TOKEN},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Tester"
    assert result["data"] == {CONF_URL: URL, CONF_TOKEN: TOKEN}


async def test_invalid_token_shows_error(
    hass: HomeAssistant, aioclient_mock
) -> None:
    aioclient_mock.get(
        f"{URL}/api/state",
        json={"error": {"code": "unauthorized", "message": "bad token"}},
        status=401,
    )

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: URL, CONF_TOKEN: "wrong"},
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}


async def test_cannot_connect_shows_error(
    hass: HomeAssistant, aioclient_mock
) -> None:
    aioclient_mock.get(
        f"{URL}/api/state", exc=OSError("connection refused")
    )

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: URL, CONF_TOKEN: TOKEN},
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_qr_pairing_flow(
    hass: HomeAssistant, aioclient_mock
) -> None:
    aioclient_mock.get(f"{URL}/api/state", json=UNPAIRED_STATE)
    aioclient_mock.post(
        f"{URL}/api/pair/start",
        json={
            **UNPAIRED_STATE,
            "status": "pairing",
            "pairing": {
                "method": "qr",
                "qr": "data:image/png;base64,abc",
                "qr_data": "2@abcdefghijklmnop",
                "code": None,
                "updated_at": "2026-11-20T12:00:00+00:00",
            },
        },
    )

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: URL, CONF_TOKEN: TOKEN},
    )
    assert result["type"] is FlowResultType.MENU
    assert result["step_id"] == "pair"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"next_step_id": "qr"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "qr"
    assert "qr_code" in result["data_schema"].schema

    # Scanning succeeds by the time the user submits the form.
    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{URL}/api/state", json=CONNECTED_STATE)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Tester"


async def test_entry_is_not_added_twice(
    hass: HomeAssistant, aioclient_mock
) -> None:
    MockConfigEntry(
        domain=DOMAIN,
        unique_id="instance-1",
        data={CONF_URL: URL, CONF_TOKEN: TOKEN},
    ).add_to_hass(hass)
    aioclient_mock.get(f"{URL}/api/state", json=CONNECTED_STATE)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: URL, CONF_TOKEN: TOKEN},
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_options_flow_can_start_pairing(
    hass: HomeAssistant, aioclient_mock
) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id="instance-1",
        title="Tester",
        data={CONF_URL: URL, CONF_TOKEN: TOKEN},
    )
    entry.add_to_hass(hass)
    aioclient_mock.post(
        f"{URL}/api/pair/start",
        json={
            **UNPAIRED_STATE,
            "status": "pairing",
            "pairing": {
                "method": "qr",
                "qr": "data:image/png;base64,abc",
                "qr_data": "2@abcdefghijklmnop",
                "code": None,
                "updated_at": "2026-11-20T12:00:00+00:00",
            },
        },
    )

    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.MENU
    assert result["step_id"] == "init"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "pair"}
    )
    assert result["type"] is FlowResultType.MENU
    assert result["step_id"] == "pair"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "qr"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "qr"
    assert "qr_code" in result["data_schema"].schema


async def test_reauth_and_reconfigure_forms(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id="instance-1",
        title="Tester",
        data={CONF_URL: URL, CONF_TOKEN: TOKEN},
    )
    entry.add_to_hass(hass)

    reauth = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={
            "source": config_entries.SOURCE_REAUTH,
            "entry_id": entry.entry_id,
        },
        data=entry.data,
    )
    assert reauth["type"] is FlowResultType.FORM
    assert reauth["step_id"] == "reauth_confirm"

    reconfigure = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={
            "source": config_entries.SOURCE_RECONFIGURE,
            "entry_id": entry.entry_id,
        },
    )
    assert reconfigure["type"] is FlowResultType.FORM
    assert reconfigure["step_id"] == "reconfigure"
