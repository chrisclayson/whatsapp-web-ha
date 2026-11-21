"""Tests for notification text helpers."""

from __future__ import annotations

from notification_text import notification_content, parse_notify_service


def test_direct_message_notification():
    title, message = notification_content(
        {
            "sender_name": "Alice",
            "is_group": False,
            "text": "Hello 👋",
        }
    )
    assert title == "WhatsApp: Alice"
    assert message == "Alice:\nHello 👋"


def test_group_message_notification():
    title, message = notification_content(
        {
            "sender_name": "Alice",
            "is_group": True,
            "group_name": "Family",
            "text": "Dinner at 7? 🍕",
        }
    )
    assert title == "WhatsApp: Family"
    assert message == "Alice (Family):\nDinner at 7? 🍕"


def test_missing_names_and_media_fallback():
    title, message = notification_content(
        {
            "sender_name": "unknown",
            "is_group": True,
            "group_name": "unknown",
            "type": "image",
        }
    )
    assert title == "WhatsApp: unknown"
    assert message == "unknown (unknown):\n[Photo]"


def test_multiline_message_is_preserved():
    _, message = notification_content(
        {
            "sender_name": "Alice",
            "is_group": False,
            "text": "Line one\nLine two 🎉",
        }
    )
    assert message == "Alice:\nLine one\nLine two 🎉"


def test_parse_notify_service():
    assert parse_notify_service("notify.mobile_app_phone") == (
        "notify",
        "mobile_app_phone",
    )
    assert parse_notify_service("mobile_app_phone") == (
        "notify",
        "mobile_app_phone",
    )
    assert parse_notify_service("  notify.persistent_notification  ") == (
        "notify",
        "persistent_notification",
    )
    assert parse_notify_service("") is None
    assert parse_notify_service("notify.") is None
    assert parse_notify_service(".service") is None
