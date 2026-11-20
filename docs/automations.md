# Automation examples

All examples use `whatsapp` in entity IDs. Replace it with your account's slug:
if the linked WhatsApp name is **Alice**, the entities are
`event.alice_message`, `sensor.alice_unread_messages` and
`binary_sensor.alice_connection`.

## Notify on every incoming message

```yaml
alias: WhatsApp - notify on new message
trigger:
  - platform: event
    event_type: whatsapp_web_message
action:
  - service: notify.mobile_app_phone
    data:
      title: >-
        {{ trigger.event.data.chat_name
           or trigger.event.data.sender_name
           or trigger.event.data.chat_id }}
      message: >-
        {% if trigger.event.data.has_media and not trigger.event.data.text %}
        [{{ trigger.event.data.type }}]
        {% else %}
        {{ trigger.event.data.text }}
        {% endif %}
mode: queued
max: 20
```

## Only direct messages, not groups

```yaml
trigger:
  - platform: event
    event_type: whatsapp_web_message
condition:
  - condition: template
    value_template: "{{ not trigger.event.data.from_me }}"
  - condition: template
    value_template: "{{ not trigger.event.data.is_group }}"
action:
  - service: notify.mobile_app_phone
    data:
      title: "{{ trigger.event.data.sender_name }}"
      message: "{{ trigger.event.data.text }}"
```

## Only messages that mention you

```yaml
trigger:
  - platform: event
    event_type: whatsapp_web_message
condition:
  - condition: template
    value_template: >-
      {{ '15550000000@s.whatsapp.net' in trigger.event.data.mentions }}
action:
  - service: notify.mobile_app_phone
    data:
      title: "Mentioned in {{ trigger.event.data.chat_name }}"
      message: "{{ trigger.event.data.text }}"
```

## Keyword escalation

```yaml
alias: WhatsApp - urgent keywords
trigger:
  - platform: event
    event_type: whatsapp_web_message
condition:
  - condition: template
    value_template: >-
      {{ trigger.event.data.text | lower is search('urgent|asap|emergency|help') }}
action:
  - service: notify.mobile_app_phone
    data:
      title: "URGENT: {{ trigger.event.data.chat_name }}"
      message: "{{ trigger.event.data.text }}"
      data:
        priority: high
        channel: alarm_stream
  - service: light.turn_on
    target:
      entity_id: light.office
    data:
      color_name: red
      brightness: 255
```

## Unread threshold with a daily nudge

```yaml
alias: WhatsApp - unread reminder
trigger:
  - platform: time
    at: "18:00:00"
condition:
  - condition: numeric_state
    entity_id: sensor.whatsapp_unread_messages
    above: 5
action:
  - service: notify.mobile_app_phone
    data:
      title: "{{ states('sensor.whatsapp_unread_messages') }} unread WhatsApp messages"
      message: >-
        {% for chat in state_attr('sensor.whatsapp_unread_messages', 'chats') %}
        {{ chat.name or chat.id }}: {{ chat.unread }}
        {% endfor %}
```

## Mark a chat read from a button

```yaml
alias: WhatsApp - clear family chat
trigger:
  - platform: state
    entity_id: input_button.clear_family_whatsapp
action:
  - service: whatsapp_web.mark_read
    data:
      chat: "120363000000000000@g.us"
```

## Send a message and use the response

```yaml
alias: WhatsApp - send garage warning
trigger:
  - platform: state
    entity_id: binary_sensor.garage_door
    to: "on"
    for: "00:05:00"
action:
  - service: whatsapp_web.send_typing
    data:
      chat: "15551234567@s.whatsapp.net"
      state: composing
  - delay: "00:00:02"
  - service: whatsapp_web.send_message
    data:
      to: "+15551234567"
      message: "The garage door has been open for five minutes."
    response_variable: sent
  - service: whatsapp_web.send_typing
    data:
      chat: "15551234567@s.whatsapp.net"
      state: paused
  - service: logbook.log
    data:
      name: WhatsApp
      message: "Sent {{ sent.message_id }} to {{ sent.chat_id }}"
```

## Trigger from the event entity instead of the bus

Useful when you prefer the UI trigger editor; the entity carries the same
fields as attributes.

```yaml
trigger:
  - platform: state
    entity_id: event.whatsapp_message
    attribute: event_type
    to: message_received
action:
  - service: persistent_notification.create
    data:
      title: "{{ trigger.to_state.attributes.chat_name }}"
      message: "{{ trigger.to_state.attributes.text }}"
```

## Forward only photos and documents to a folder

```yaml
trigger:
  - platform: event
    event_type: whatsapp_web_message
condition:
  - condition: template
    value_template: >-
      {{ trigger.event.data.type in ['image', 'video', 'document'] }}
action:
  - service: persistent_notification.create
    data:
      title: "Media from {{ trigger.event.data.chat_name }}"
      message: >-
        {{ trigger.event.data.type }} ·
        {{ (trigger.event.data.media or {}).get('mimetype', 'unknown') }} ·
        {{ (trigger.event.data.media or {}).get('file_length', 0) }} bytes
```

Media is not downloaded by the bridge; this example only uses the metadata
(`type`, `media`).

## Ignore your own outgoing messages

`from_me` is `true` for messages sent from the phone or through Home Assistant.
The integration option **Fire events for messages sent from the phone** controls
whether those emit events at all. As a second guard:

```yaml
condition:
  - condition: template
    value_template: "{{ not trigger.event.data.from_me }}"
```
