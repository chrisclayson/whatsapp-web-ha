/**
 * WhatsApp Messages card for the WhatsApp Web integration.
 *
 * Renders the messages attribute of the "Received messages" sensor. The
 * integration already stores incoming messages only, but from_me is filtered
 * again here so replies are never shown.
 */

const CARD_TYPE = "whatsapp-messages-card";

const DEFAULTS = {
  title: "WhatsApp",
  max_messages: 20,
  show_group: true,
  show_time: true,
  show_avatar: true,
};

const TYPE_LABELS = {
  image: "Photo",
  video: "Video",
  audio: "Audio",
  voice: "Voice message",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contact: "Contact",
  poll: "Poll",
  reaction: "Reaction",
  group_invite: "Group invite",
};

const CSS = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--divider-color);
  }
  .header ha-icon {
    color: #25d366;
    --mdc-icon-size: 26px;
  }
  .title {
    font-size: 18px;
    font-weight: 600;
    color: var(--primary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    margin-left: auto;
    min-width: 24px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--secondary-background-color);
    color: var(--secondary-text-color);
    font-size: 12px;
    font-weight: 600;
    text-align: center;
  }
  .list {
    max-height: 440px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .message {
    display: flex;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid var(--divider-color);
  }
  .message:first-child { border-top: none; }
  .avatar {
    flex: 0 0 36px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    user-select: none;
  }
  .body { flex: 1; min-width: 0; }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    font-size: 14px;
  }
  .name {
    font-weight: 600;
    color: var(--primary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sender {
    color: var(--secondary-text-color);
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    margin-left: auto;
    padding-left: 8px;
    color: var(--secondary-text-color);
    font-size: 12px;
    white-space: nowrap;
  }
  .text {
    margin-top: 2px;
    color: var(--primary-text-color);
    font-size: 14px;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .empty {
    padding: 30px 16px;
    text-align: center;
    color: var(--secondary-text-color);
    font-size: 14px;
  }
  .empty ha-icon {
    display: block;
    margin: 0 auto 8px;
    --mdc-icon-size: 32px;
    opacity: 0.55;
  }
  @media (max-width: 420px) {
    .avatar { display: none; }
    .message { padding: 10px 14px; }
  }
`;

class WhatsAppMessagesCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { ...DEFAULTS };
    this._hass = null;
    this._stateObj = null;
  }

  static getStubConfig(hass) {
    const entity = Object.keys(hass.states).find(
      (id) =>
        id.startsWith("sensor.") &&
        Array.isArray(hass.states[id].attributes.messages)
    );
    return { entity: entity || "sensor.whatsapp_received_messages" };
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error(
        "WhatsApp Messages card: set entity to the integration's Received messages sensor."
      );
    }
    this._config = { ...DEFAULTS, ...config };
    this._stateObj = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config.entity) return;
    const stateObj = hass.states[this._config.entity];
    if (stateObj === this._stateObj) return;
    this._stateObj = stateObj;
    this._render();
  }

  getCardSize() {
    return 4;
  }

  _render() {
    const root = this.shadowRoot;
    if (!root) return;
    root.replaceChildren();

    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style);

    const card = document.createElement("ha-card");
    root.append(card);

    const stateObj = this._hass?.states?.[this._config.entity];
    const allMessages = Array.isArray(stateObj?.attributes?.messages)
      ? stateObj.attributes.messages
      : [];
    const limit = Math.max(1, Number(this._config.max_messages) || 20);
    const messages = allMessages
      .filter((message) => message && !message.from_me)
      .slice(0, limit);

    card.append(this._header(messages.length));

    if (!stateObj) {
      card.append(
        this._empty(`Entity ${this._config.entity} was not found.`)
      );
      return;
    }

    if (!messages.length) {
      card.append(
        this._empty("No received messages yet.", "mdi:message-outline")
      );
      return;
    }

    const list = document.createElement("div");
    list.className = "list";
    for (const message of messages) {
      list.append(this._messageRow(message));
    }
    card.append(list);
  }

  _header(count) {
    const header = document.createElement("div");
    header.className = "header";

    const icon = document.createElement("ha-icon");
    icon.setAttribute("icon", "mdi:whatsapp");
    header.append(icon);

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = this._config.title || DEFAULTS.title;
    header.append(title);

    const badge = document.createElement("div");
    badge.className = "count";
    badge.textContent = String(count);
    badge.title = `${count} received message${count === 1 ? "" : "s"}`;
    header.append(badge);

    return header;
  }

  _messageRow(message) {
    const row = document.createElement("div");
    row.className = "message";

    const sender = senderLabel(message);
    const group = message.is_group
      ? message.group_name || "unknown"
      : null;

    if (this._config.show_avatar) {
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = initials(sender);
      avatar.style.background = message.is_group
        ? "#25d366"
        : "var(--primary-color)";
      row.append(avatar);
    }

    const body = document.createElement("div");
    body.className = "body";

    const meta = document.createElement("div");
    meta.className = "meta";

    const name = document.createElement("div");
    name.className = "name";
    if (group && this._config.show_group) {
      name.textContent = group;
      const senderSpan = document.createElement("span");
      senderSpan.className = "sender";
      senderSpan.textContent = ` · ${sender}`;
      name.append(senderSpan);
    } else {
      name.textContent = sender;
    }
    meta.append(name);

    if (this._config.show_time) {
      const time = document.createElement("div");
      time.className = "time";
      time.textContent = formatTime(message);
      meta.append(time);
    }

    body.append(meta);

    const text = document.createElement("div");
    text.className = "text";
    text.textContent = messageText(message);
    body.append(text);

    row.append(body);
    return row;
  }

  _empty(text, iconName = "mdi:alert-circle-outline") {
    const empty = document.createElement("div");
    empty.className = "empty";
    const icon = document.createElement("ha-icon");
    icon.setAttribute("icon", iconName);
    empty.append(icon);
    empty.append(document.createTextNode(text));
    return empty;
  }
}

function senderLabel(message) {
  const name = String(message.sender_name || "").trim();
  if (name && name.toLowerCase() !== "unknown") return name;
  const username = String(message.sender_username || "").trim();
  return username || "unknown";
}

function initials(name) {
  const value = String(name || "").trim();
  if (!value || value.toLowerCase() === "unknown") return "?";
  const parts = value.split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function messageText(message) {
  const text = String(message.text || "").trim();
  if (text) return text;
  const label = TYPE_LABELS[message.type] || message.type || "message";
  return `[${label}]`;
}

function formatTime(message) {
  const epoch = Number(message.timestamp_epoch);
  let date;
  if (Number.isFinite(epoch) && epoch > 0) {
    date = new Date(epoch * 1000);
  } else if (message.timestamp) {
    date = new Date(message.timestamp);
  }
  if (!date || Number.isNaN(date.getTime())) return "";

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, WhatsAppMessagesCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: "WhatsApp Messages",
    description: "Shows received WhatsApp messages without your replies.",
    preview: false,
  });
}
