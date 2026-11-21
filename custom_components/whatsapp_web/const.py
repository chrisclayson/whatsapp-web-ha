"""Constants for the WhatsApp Web integration."""

from __future__ import annotations

DOMAIN = "whatsapp_web"
NAME = "WhatsApp Web"

CONF_URL = "url"
CONF_TOKEN = "token"
CONF_POLL_INTERVAL = "poll_interval"
CONF_FIRE_OUTGOING_EVENTS = "fire_outgoing_events"

DEFAULT_URL = "http://homeassistant.local:3000"
DEFAULT_POLL_INTERVAL = 30

STATE_CONNECTED = "connected"
STATE_PAIRING = "pairing"

EVENT_MESSAGE = f"{DOMAIN}_message"
EVENT_TYPE_MESSAGE_RECEIVED = "message_received"
EVENT_TYPE_MESSAGE_SENT = "message_sent"

SERVICE_SEND_MESSAGE = "send_message"
SERVICE_MARK_READ = "mark_read"
SERVICE_SEND_TYPING = "send_typing"

ATTR_ENTRY_ID = "entry_id"
ATTR_TO = "to"
ATTR_MESSAGE = "message"
ATTR_CHAT = "chat"
ATTR_MESSAGE_IDS = "message_ids"
ATTR_STATE = "state"

UNREAD_CHAT_LIMIT = 20
MAX_TEXT_LENGTH = 255
RECENT_MESSAGE_LIMIT = 20
RECENT_MESSAGE_TEXT_LIMIT = 300

CARD_URL = f"/{DOMAIN}/whatsapp-messages-card.js"


def message_signal(entry_id: str) -> str:
    """Return the dispatcher signal used for message events of an entry."""
    return f"{DOMAIN}_message_{entry_id}"


def messages_signal(entry_id: str) -> str:
    """Return the dispatcher signal used for the recent-message buffer."""
    return f"{DOMAIN}_messages_{entry_id}"
