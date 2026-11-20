"""Small asyncio client for the local WhatsApp bridge.

This module intentionally has no Home Assistant imports so it can be unit
tested in isolation.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlparse, urlunparse

import aiohttp

_LOGGER = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30


class BridgeError(Exception):
    """Base error raised for bridge API failures."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class BridgeAuthError(BridgeError):
    """The bridge rejected the API token."""


class BridgeConnectionError(BridgeError):
    """The bridge could not be reached."""


def normalize_url(url: str) -> str:
    """Normalize a user supplied bridge URL."""
    value = url.strip().rstrip("/")
    if not value:
        raise ValueError("A bridge URL is required")
    if "://" not in value:
        value = f"http://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("The bridge URL must be a valid http(s) URL")
    return value


class BridgeClient:
    """Thin HTTP/WebSocket client for the bridge."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        url: str,
        token: str,
        *,
        timeout: int = DEFAULT_TIMEOUT,
    ) -> None:
        self._session = session
        self.base_url = normalize_url(url)
        self.token = token
        self._timeout = aiohttp.ClientTimeout(total=timeout)

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    @property
    def ws_url(self) -> str:
        parsed = urlparse(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunparse((scheme, parsed.netloc, "/ws", "", "", ""))

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            async with self._session.request(
                method,
                url,
                json=payload,
                headers=self._headers,
                timeout=self._timeout,
            ) as response:
                text = await response.text()
                data: Any = {}
                if text:
                    try:
                        data = json.loads(text)
                    except ValueError:
                        data = {}

                if response.status == 401:
                    raise BridgeAuthError(
                        "The bridge rejected the API token",
                        status=response.status,
                        code="unauthorized",
                    )
                if response.status >= 400:
                    error = data.get("error", {}) if isinstance(data, dict) else {}
                    raise BridgeError(
                        error.get("message")
                        or f"Bridge returned HTTP {response.status}",
                        status=response.status,
                        code=error.get("code"),
                    )
                return data if isinstance(data, dict) else {"value": data}
        except (aiohttp.ClientError, OSError, TimeoutError) as err:
            raise BridgeConnectionError(
                f"Could not reach the WhatsApp bridge at {self.base_url}: {err}"
            ) from err

    async def health(self) -> dict[str, Any]:
        """Return the public health response."""
        return await self._request("GET", "/healthz")

    async def get_state(self) -> dict[str, Any]:
        """Return the full bridge state."""
        return await self._request("GET", "/api/state")

    async def get_chats(self) -> list[dict[str, Any]]:
        """Return all known chats."""
        data = await self._request("GET", "/api/chats")
        return data.get("chats", [])

    async def start_pair(
        self, method: str = "qr", phone: str | None = None
    ) -> dict[str, Any]:
        """Start (or resume) pairing and wait for a QR/pairing code."""
        payload: dict[str, Any] = {"method": method}
        if phone:
            payload["phone"] = phone
        return await self._request("POST", "/api/pair/start", payload)

    async def cancel_pair(self) -> None:
        """Cancel an in-progress pairing attempt."""
        await self._request("POST", "/api/pair/cancel")

    async def logout(self) -> None:
        """Unlink the device and clear the bridge session."""
        await self._request("POST", "/api/logout")

    async def send_message(self, to: str, message: str) -> dict[str, Any]:
        """Send a text message."""
        return await self._request(
            "POST",
            "/api/send",
            {"to": to, "message": message},
        )

    async def mark_read(
        self, chat: str, message_ids: list[str] | None = None
    ) -> dict[str, Any]:
        """Mark a chat (or specific messages) as read."""
        payload: dict[str, Any] = {"chat": chat}
        if message_ids is not None:
            payload["message_ids"] = message_ids
        return await self._request("POST", "/api/read", payload)

    async def send_typing(self, chat: str, state: str = "composing") -> dict[str, Any]:
        """Send a typing/paused presence update."""
        return await self._request(
            "POST",
            "/api/typing",
            {"chat": chat, "state": state},
        )

    async def listen(self) -> AsyncIterator[dict[str, Any]]:
        """Yield frames from the bridge WebSocket until it closes."""
        try:
            async with self._session.ws_connect(
                self.ws_url,
                headers=self._headers,
                heartbeat=30,
                timeout=aiohttp.ClientWSTimeout(ws_close=10),
            ) as websocket:
                async for message in websocket:
                    if message.type == aiohttp.WSMsgType.TEXT:
                        try:
                            frame = json.loads(message.data)
                        except ValueError:
                            _LOGGER.debug("Ignoring non-JSON bridge frame")
                            continue
                        if isinstance(frame, dict):
                            yield frame
                    elif message.type == aiohttp.WSMsgType.ERROR:
                        raise BridgeConnectionError(
                            f"Bridge WebSocket error: {websocket.exception()}"
                        )
                    elif message.type in (
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.CLOSE,
                    ):
                        return
        except aiohttp.WSServerHandshakeError as err:
            if err.status == 401:
                raise BridgeAuthError(
                    "The bridge rejected the API token",
                    status=err.status,
                    code="unauthorized",
                ) from err
            raise BridgeConnectionError(
                f"Bridge WebSocket connection failed: {err}"
            ) from err
        except (aiohttp.ClientError, OSError, TimeoutError) as err:
            raise BridgeConnectionError(
                f"Bridge WebSocket connection failed: {err}"
            ) from err
