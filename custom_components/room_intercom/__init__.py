"""Room Intercom — push-to-talk from a Home Assistant dashboard to any
media_player speaker, with everything running inside HA Core.

No token, no IP and no entity is hardcoded: the relay URL is derived from
Home Assistant's own network configuration and the target speakers are chosen
in the Lovelace card at runtime.
"""

from __future__ import annotations

import logging
import os

import voluptuous as vol

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.network import get_url

from .const import (
    CARD_FILENAME,
    CARD_URL,
    DOMAIN,
    SERVICE_START_CALL,
    SERVICE_STOP_CALL,
    STREAM_PATH,
)
from .http import IntercomStreamView, IntercomUploadView
from .relay import RelayManager

_LOGGER = logging.getLogger(__name__)


def _resolve_ffmpeg_binary(hass: HomeAssistant) -> str:
    """Get the ffmpeg binary that ships with Home Assistant Core."""
    try:
        from homeassistant.components.ffmpeg import get_ffmpeg_manager

        return get_ffmpeg_manager(hass).binary
    except Exception:  # noqa: BLE001 — fall back to legacy data key
        from homeassistant.components.ffmpeg import DATA_FFMPEG

        return hass.data[DATA_FFMPEG].binary


async def _register_card(hass: HomeAssistant) -> None:
    """Serve the Lovelace card and auto-load it on every dashboard."""
    card_path = os.path.join(os.path.dirname(__file__), CARD_FILENAME)
    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, card_path, False)]
        )
    except (ImportError, AttributeError):
        # Older Home Assistant cores.
        hass.http.register_static_path(CARD_URL, card_path, False)
    add_extra_js_url(hass, CARD_URL)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Room Intercom from a config entry."""
    manager = RelayManager(_resolve_ffmpeg_binary(hass))
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["manager"] = manager

    hass.http.register_view(IntercomUploadView(manager))
    hass.http.register_view(IntercomStreamView(manager))
    await _register_card(hass)

    async def handle_start_call(call: ServiceCall) -> None:
        session_id = call.data["session"]
        token = call.data["token"]
        targets = call.data["entity_id"]
        volume = call.data.get("volume")

        if manager.get(session_id, token) is None:
            _LOGGER.warning("start_call for unknown session %s", session_id)
            return

        # Build the stream URL from HA's own network config — prefer the LAN
        # address so the speaker can reach it; never use the cloud URL.
        base = get_url(
            hass,
            allow_internal=True,
            allow_external=True,
            allow_cloud=False,
            prefer_external=False,
        ).rstrip("/")
        stream_url = f"{base}{STREAM_PATH}?session={session_id}&token={token}"

        if volume is not None:
            await hass.services.async_call(
                "media_player",
                "volume_set",
                {"entity_id": targets, "volume_level": volume},
                blocking=False,
            )
        await hass.services.async_call(
            "media_player",
            "play_media",
            {
                "entity_id": targets,
                "media_content_id": stream_url,
                "media_content_type": "music",
            },
            blocking=False,
        )

    async def handle_stop_call(call: ServiceCall) -> None:
        session_id = call.data["session"]
        targets = call.data.get("entity_id")
        if targets:
            await hass.services.async_call(
                "media_player",
                "media_stop",
                {"entity_id": targets},
                blocking=False,
            )
        session = manager.get(session_id)
        if session is not None:
            await session.close()

    hass.services.async_register(
        DOMAIN,
        SERVICE_START_CALL,
        handle_start_call,
        schema=vol.Schema(
            {
                vol.Required("session"): cv.string,
                vol.Required("token"): cv.string,
                vol.Required("entity_id"): cv.entity_ids,
                vol.Optional("volume"): vol.All(
                    vol.Coerce(float), vol.Range(min=0, max=1)
                ),
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_STOP_CALL,
        handle_stop_call,
        schema=vol.Schema(
            {
                vol.Required("session"): cv.string,
                vol.Optional("entity_id"): cv.entity_ids,
            }
        ),
    )

    _LOGGER.info("Room Intercom set up")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    data = hass.data.get(DOMAIN, {})
    manager: RelayManager | None = data.get("manager")
    if manager is not None:
        await manager.close_all()

    hass.services.async_remove(DOMAIN, SERVICE_START_CALL)
    hass.services.async_remove(DOMAIN, SERVICE_STOP_CALL)
    hass.data.pop(DOMAIN, None)
    return True
