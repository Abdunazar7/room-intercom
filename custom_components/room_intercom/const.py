"""Constants for the Room Intercom integration."""

DOMAIN = "room_intercom"

# Static path under which the Lovelace card is served.
CARD_FILENAME = "intercom-card.js"
CARD_URL = "/room_intercom/intercom-card.js"

# HTTP relay endpoints (no IP/port hardcoded — built from hass at runtime).
WS_UPLOAD_PATH = "/api/room_intercom/ws"
STREAM_PATH = "/api/room_intercom/stream"

# Audio format the browser sends (raw PCM) — must match the card.
INPUT_SAMPLE_RATE = 48000
INPUT_CHANNELS = 1

SERVICE_START_CALL = "start_call"
SERVICE_STOP_CALL = "stop_call"
