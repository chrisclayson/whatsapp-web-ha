"""Config and options flow for WhatsApp Web."""

from __future__ import annotations

import logging
import re
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    QrCodeSelector,
    QrCodeSelectorConfig,
    QrErrorCorrectionLevel,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .bridge import (
    BridgeAuthError,
    BridgeClient,
    BridgeConnectionError,
    BridgeError,
)
from .const import (
    CONF_FIRE_OUTGOING_EVENTS,
    CONF_NOTIFY_ON_MESSAGE,
    CONF_NOTIFY_SERVICE,
    CONF_POLL_INTERVAL,
    CONF_TOKEN,
    CONF_URL,
    DEFAULT_POLL_INTERVAL,
    DEFAULT_URL,
    DOMAIN,
    STATE_CONNECTED,
)
from .notification_text import parse_notify_service

_LOGGER = logging.getLogger(__name__)

PHONE_RE = re.compile(r"^\+?[0-9][0-9\s\-().]{4,22}$")


def _error_key(err: BridgeError) -> str:
    if isinstance(err, BridgeAuthError):
        return "invalid_auth"
    if isinstance(err, BridgeConnectionError):
        return "cannot_connect"
    if err.code == "pairing_timeout":
        return "pairing_timeout"
    if err.code in ("parsing_failed", "pairing_failed"):
        return "pairing_failed"
    return "unknown"


def _connection_schema(
    default_url: str = DEFAULT_URL, default_token: str = ""
) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_URL, default=default_url): TextSelector(
                TextSelectorConfig(type=TextSelectorType.URL)
            ),
            vol.Required(CONF_TOKEN, default=default_token): TextSelector(
                TextSelectorConfig(type=TextSelectorType.PASSWORD)
            ),
        }
    )


def _phone_schema() -> vol.Schema:
    return vol.Schema(
        {
            vol.Required("phone"): TextSelector(
                TextSelectorConfig(type=TextSelectorType.TEL)
            )
        }
    )


class PairingFlowMixin:
    """Shared QR / phone pairing steps for config, options and reconfigure."""

    _client: BridgeClient | None = None
    _state: dict[str, Any] | None = None
    _phone: str | None = None

    def _finish_pairing(self, state: dict[str, Any]) -> ConfigFlowResult:
        raise NotImplementedError

    def _entry_data(self) -> dict[str, Any]:
        assert self._client is not None
        return {
            CONF_URL: self._client.base_url,
            CONF_TOKEN: self._client.token,
        }

    async def async_step_pair(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return self.async_show_menu(
            step_id="pair",
            menu_options=["qr", "phone", "later"],
        )

    async def async_step_qr(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        state: dict[str, Any] = {}

        if self._client is None:
            return self.async_abort(reason="cannot_connect")

        if user_input is not None:
            try:
                state = await self._client.get_state()
            except BridgeError as err:
                errors["base"] = _error_key(err)
                state = self._state or {}
            else:
                if state.get("status") == STATE_CONNECTED:
                    return self._finish_pairing(state)
                self._state = state

        pairing = state.get("pairing") or {}
        if not pairing.get("qr_data"):
            try:
                state = await self._client.start_pair("qr")
            except BridgeError as err:
                errors.setdefault("base", _error_key(err))
                state = self._state or {}
            else:
                self._state = state
            if state.get("status") == STATE_CONNECTED:
                return self._finish_pairing(state)
            pairing = state.get("pairing") or {}

        qr_data = pairing.get("qr_data")
        if not qr_data:
            if errors:
                return self.async_show_form(
                    step_id="qr",
                    data_schema=vol.Schema({}),
                    errors=errors,
                )
            return self.async_abort(reason="qr_unavailable")

        return self.async_show_form(
            step_id="qr",
            data_schema=vol.Schema(
                {
                    vol.Optional("qr_code"): QrCodeSelector(
                        QrCodeSelectorConfig(
                            data=qr_data,
                            scale=5,
                            error_correction_level=QrErrorCorrectionLevel.QUARTILE,
                        )
                    )
                }
            ),
            errors=errors,
        )

    async def async_step_phone(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            phone = user_input["phone"].strip()
            if not PHONE_RE.match(phone):
                errors["phone"] = "invalid_phone"
            elif self._client is None:
                return self.async_abort(reason="cannot_connect")
            else:
                try:
                    state = await self._client.start_pair("phone", phone)
                except BridgeError as err:
                    errors["base"] = _error_key(err)
                else:
                    self._state = state
                    self._phone = phone
                    if state.get("status") == STATE_CONNECTED:
                        return self._finish_pairing(state)
                    if not (state.get("pairing") or {}).get("code"):
                        errors["base"] = "pairing_failed"
                    else:
                        return await self.async_step_phone_code()

        return self.async_show_form(
            step_id="phone",
            data_schema=_phone_schema(),
            errors=errors,
            description_placeholders={
                "example": "+15551234567",
            },
        )

    async def async_step_phone_code(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None and self._client is not None:
            try:
                state = await self._client.get_state()
            except BridgeError as err:
                errors["base"] = _error_key(err)
            else:
                if state.get("status") == STATE_CONNECTED:
                    return self._finish_pairing(state)
                try:
                    state = await self._client.start_pair("phone", self._phone)
                except BridgeError as err:
                    errors["base"] = _error_key(err)
                else:
                    self._state = state
                    if state.get("status") == STATE_CONNECTED:
                        return self._finish_pairing(state)
                    if not (state.get("pairing") or {}).get("code"):
                        errors["base"] = "pairing_failed"

        pairing = (self._state or {}).get("pairing") or {}
        if self._phone is None:
            self._phone = pairing.get("phone")
        return self.async_show_form(
            step_id="phone_code",
            data_schema=vol.Schema({}),
            errors=errors,
            description_placeholders={
                "code": pairing.get("code") or "--------",
                "phone": self._phone or "",
            },
        )

    async def async_step_later(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return self._finish_pairing(self._state or {})


class WhatsAppWebConfigFlow(PairingFlowMixin, ConfigFlow, domain=DOMAIN):
    """Handle the initial setup."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        """Return the options flow."""
        return WhatsAppWebOptionsFlow()

    def __init__(self) -> None:
        self._client = None
        self._state = None
        self._phone = None
        self._reauth_entry: ConfigEntry | None = None

    def _finish_pairing(self, state: dict[str, Any]) -> ConfigFlowResult:
        me = state.get("me") or {}
        title = me.get("name") or me.get("phone") or "WhatsApp"
        return self.async_create_entry(title=title, data=self._entry_data())

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                client = BridgeClient(
                    async_get_clientsession(self.hass),
                    user_input[CONF_URL],
                    user_input[CONF_TOKEN],
                )
            except ValueError:
                errors["base"] = "invalid_url"
            else:
                try:
                    state = await client.get_state()
                except BridgeAuthError:
                    errors["base"] = "invalid_auth"
                except BridgeConnectionError:
                    errors["base"] = "cannot_connect"
                except BridgeError:
                    errors["base"] = "unknown"
                else:
                    self._client = client
                    self._state = state
                    await self.async_set_unique_id(
                        state.get("instance_id") or client.base_url
                    )
                    self._abort_if_unique_id_configured()
                    if state.get("status") == STATE_CONNECTED:
                        return self._finish_pairing(state)
                    return await self.async_step_pair()

        return self.async_show_form(
            step_id="user",
            data_schema=_connection_schema(),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: dict[str, Any]
    ) -> ConfigFlowResult:
        entry_id = self.context.get("entry_id")
        self._reauth_entry = (
            self.hass.config_entries.async_get_entry(entry_id)
            if entry_id
            else None
        )
        if self._reauth_entry is None:
            return self.async_abort(reason="reauth_failed")
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self._reauth_entry
        if entry is None:
            return self.async_abort(reason="reauth_failed")

        if user_input is not None:
            try:
                client = BridgeClient(
                    async_get_clientsession(self.hass),
                    entry.data[CONF_URL],
                    user_input[CONF_TOKEN],
                )
                await client.get_state()
            except BridgeAuthError:
                errors["base"] = "invalid_auth"
            except BridgeConnectionError:
                errors["base"] = "cannot_connect"
            except (BridgeError, ValueError):
                errors["base"] = "unknown"
            else:
                self.hass.config_entries.async_update_entry(
                    entry,
                    data={**entry.data, CONF_TOKEN: user_input[CONF_TOKEN]},
                )
                await self.hass.config_entries.async_reload(entry.entry_id)
                return self.async_abort(reason="reauth_successful")

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_TOKEN): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.PASSWORD)
                    )
                }
            ),
            errors=errors,
            description_placeholders={"url": entry.data[CONF_URL]},
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry_id = self.context.get("entry_id")
        entry = (
            self.hass.config_entries.async_get_entry(entry_id)
            if entry_id
            else None
        )
        if entry is None:
            return self.async_abort(reason="reconfigure_failed")

        if user_input is not None:
            try:
                client = BridgeClient(
                    async_get_clientsession(self.hass),
                    user_input[CONF_URL],
                    user_input[CONF_TOKEN],
                )
                await client.get_state()
            except ValueError:
                errors["base"] = "invalid_url"
            except BridgeAuthError:
                errors["base"] = "invalid_auth"
            except BridgeConnectionError:
                errors["base"] = "cannot_connect"
            except BridgeError:
                errors["base"] = "unknown"
            else:
                self.hass.config_entries.async_update_entry(
                    entry,
                    data={
                        CONF_URL: client.base_url,
                        CONF_TOKEN: user_input[CONF_TOKEN],
                    },
                )
                await self.hass.config_entries.async_reload(entry.entry_id)
                return self.async_abort(reason="reconfigure_successful")

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_connection_schema(
                entry.data[CONF_URL], entry.data[CONF_TOKEN]
            ),
            errors=errors,
        )


class WhatsAppWebOptionsFlow(PairingFlowMixin, OptionsFlow):
    """Options, including pairing an account that was skipped at setup."""

    def __init__(self) -> None:
        self._client = None
        self._state = None
        self._phone = None

    def _finish_pairing(self, state: dict[str, Any]) -> ConfigFlowResult:
        return self.async_create_entry(
            title="", data=dict(self.config_entry.options)
        )

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if self._client is None:
            self._client = BridgeClient(
                async_get_clientsession(self.hass),
                self.config_entry.data[CONF_URL],
                self.config_entry.data[CONF_TOKEN],
            )
        return self.async_show_menu(
            step_id="init",
            menu_options=["settings", "pair"],
        )

    async def async_step_settings(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        entry = self.config_entry
        errors: dict[str, str] = {}
        notify_service = str(
            (user_input or {}).get(CONF_NOTIFY_SERVICE)
            or entry.options.get(CONF_NOTIFY_SERVICE, "")
        ).strip()

        if user_input is not None:
            parsed_service = parse_notify_service(notify_service)
            if notify_service and (
                parsed_service is None
                or not self.hass.services.has_service(*parsed_service)
            ):
                errors[CONF_NOTIFY_SERVICE] = "invalid_notify_service"

            if not errors:
                try:
                    client = BridgeClient(
                        async_get_clientsession(self.hass),
                        user_input[CONF_URL],
                        user_input[CONF_TOKEN],
                    )
                    await client.get_state()
                except ValueError:
                    errors["base"] = "invalid_url"
                except BridgeAuthError:
                    errors["base"] = "invalid_auth"
                except BridgeConnectionError:
                    errors["base"] = "cannot_connect"
                except BridgeError:
                    errors["base"] = "unknown"
                else:
                    self.hass.config_entries.async_update_entry(
                        entry,
                        data={
                            CONF_URL: client.base_url,
                            CONF_TOKEN: user_input[CONF_TOKEN],
                        },
                    )
                    return self.async_create_entry(
                        title="",
                        data={
                            CONF_POLL_INTERVAL: user_input[CONF_POLL_INTERVAL],
                            CONF_FIRE_OUTGOING_EVENTS: user_input[
                                CONF_FIRE_OUTGOING_EVENTS
                            ],
                            CONF_NOTIFY_ON_MESSAGE: user_input[
                                CONF_NOTIFY_ON_MESSAGE
                            ],
                            CONF_NOTIFY_SERVICE: notify_service,
                        },
                    )

        return self.async_show_form(
            step_id="settings",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_URL, default=entry.data[CONF_URL]
                    ): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.URL)
                    ),
                    vol.Required(
                        CONF_TOKEN, default=entry.data[CONF_TOKEN]
                    ): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.PASSWORD)
                    ),
                    vol.Required(
                        CONF_POLL_INTERVAL,
                        default=entry.options.get(
                            CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL
                        ),
                    ): vol.All(vol.Coerce(int), vol.Range(min=10, max=600)),
                    vol.Required(
                        CONF_FIRE_OUTGOING_EVENTS,
                        default=entry.options.get(
                            CONF_FIRE_OUTGOING_EVENTS, False
                        ),
                    ): cv.boolean,
                    vol.Required(
                        CONF_NOTIFY_ON_MESSAGE,
                        default=entry.options.get(
                            CONF_NOTIFY_ON_MESSAGE, False
                        ),
                    ): cv.boolean,
                    vol.Optional(
                        CONF_NOTIFY_SERVICE,
                        default=entry.options.get(CONF_NOTIFY_SERVICE, ""),
                    ): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.TEXT)
                    ),
                }
            ),
            errors=errors,
        )
