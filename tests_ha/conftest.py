"""Fixtures for Home Assistant integration tests."""

from __future__ import annotations

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Enable loading custom integrations in all tests."""
    yield


@pytest.fixture(autouse=True)
def expected_lingering_tasks() -> bool:
    """The bridge listener is a long-running background task by design."""
    return True
