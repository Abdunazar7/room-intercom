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

# Built-in HTTPS reverse proxy so the browser microphone works (a secure context
# is required for getUserMedia) even when no other HTTPS is present. If another
# intercom proxy (e.g. BMS Intercom / domofon) already owns the port, whichever
# starts first binds it and the other simply reuses it — they share one port.
CONF_ENABLE_HTTPS = "enable_https"
CONF_PROXY_PORT = "proxy_port"
DEFAULT_ENABLE_HTTPS = True
DEFAULT_PROXY_PORT = 8443

# Self-signed certificate location (under HA config dir).
CERT_DIR = "room_intercom"
CERT_FILE = "https_cert.pem"
KEY_FILE = "https_key.pem"
