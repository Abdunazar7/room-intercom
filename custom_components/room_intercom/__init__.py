"""Room Intercom — push-to-talk from a Home Assistant dashboard to any
media_player speaker, with everything running inside HA Core.

No token, no IP and no entity is hardcoded: the relay URL is derived from
Home Assistant's own network configuration and the target speakers are chosen
in the Lovelace card at runtime.
"""

from __future__ import annotations

import asyncio
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
    CERT_DIR,
    CERT_FILE,
    CONF_ENABLE_HTTPS,
    CONF_PROXY_PORT,
    DEFAULT_ENABLE_HTTPS,
    DEFAULT_PROXY_PORT,
    DOMAIN,
    KEY_FILE,
    CONF_SPEAKERS,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    SERVICE_START_CALL,
    SERVICE_STOP_CALL,
    STREAM_PATH,
)
from .http import IntercomStreamView, IntercomUploadView
from .proxy import HTTPSProxy
from .relay import RelayManager

_LOGGER = logging.getLogger(__name__)

_PROXY_KEY = f"{DOMAIN}_https_proxy"


def _resolve_ffmpeg_binary(hass: HomeAssistant) -> str:
    """Get the ffmpeg binary that ships with Home Assistant Core."""
    try:
        from homeassistant.components.ffmpeg import get_ffmpeg_manager

        return get_ffmpeg_manager(hass).binary
    except Exception:  # noqa: BLE001 — fall back to legacy data key
        from homeassistant.components.ffmpeg import DATA_FFMPEG

        return hass.data[DATA_FFMPEG].binary


async def _async_start_proxy(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Bring up the built-in HTTPS proxy so the browser mic works.

    Only one proxy per Home Assistant; if the port is already taken (e.g. by the
    BMS Intercom proxy) we reuse it instead of failing.
    """
    if not entry.options.get(CONF_ENABLE_HTTPS, DEFAULT_ENABLE_HTTPS):
        return
    if hass.data.get(_PROXY_KEY) is not None:
        return
    port = entry.options.get(CONF_PROXY_PORT, DEFAULT_PROXY_PORT)
    proxy = HTTPSProxy(
        hass,
        port,
        hass.config.path(CERT_DIR, CERT_FILE),
        hass.config.path(CERT_DIR, KEY_FILE),
    )
    hass.data[_PROXY_KEY] = proxy
    await proxy.async_start()


async def _async_speaker_base_url(hass: HomeAssistant) -> str:
    """Plain-http LAN base the speaker can pull the stream from.

    Speakers (LinkPlay/Arylic etc.) can't use the self-signed HTTPS proxy, so we
    always point them at Home Assistant's own http port on a LAN IP — never the
    HTTPS/cloud URL.
    """
    port = getattr(hass.http, "server_port", 8123) or 8123
    try:
        from homeassistant.components.network import async_get_enabled_source_ips

        for addr in await async_get_enabled_source_ips(hass):
            text = str(addr)
            if ":" in text:  # skip IPv6
                continue
            if text.startswith(("127.", "169.254.")):
                continue
            return f"http://{text}:{port}"
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Room Intercom: source IP lookup failed: %s", err)

    return get_url(
        hass,
        allow_internal=True,
        allow_external=True,
        allow_cloud=False,
        prefer_external=False,
    ).rstrip("/")


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


async def _register_panel(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Auto-register a sidebar panel so no manual dashboard is needed."""
    from homeassistant.components import frontend, panel_custom

    speakers = entry.options.get(CONF_SPEAKERS, [])

    # Re-registering raises; drop any previous panel first (e.g. on reload).
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    try:
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_URL_PATH,
            webcomponent_name=PANEL_COMPONENT,
            module_url=CARD_URL,
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=False,
            embed_iframe=False,
            config={"speakers": speakers},
        )
    except ValueError as err:
        _LOGGER.debug("Room Intercom: panel already registered: %s", err)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Room Intercom from a config entry."""
    manager = RelayManager(_resolve_ffmpeg_binary(hass))
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["manager"] = manager

    hass.http.register_view(IntercomUploadView(manager))
    hass.http.register_view(IntercomStreamView(manager))
    await _register_card(hass)
    await _register_panel(hass, entry)
    await _async_start_proxy(hass, entry)

    async def handle_start_call(call: ServiceCall) -> None:
        session_id = call.data["session"]
        token = call.data["token"]
        targets = call.data["entity_id"]
        volume = call.data.get("volume")

        # The upload WebSocket creates the session; through the HTTPS proxy it
        # may land a moment after start_call. Wait briefly instead of failing.
        if manager.get(session_id, token) is None:
            for _ in range(30):
                await asyncio.sleep(0.1)
                if manager.get(session_id, token) is not None:
                    break
        if manager.get(session_id, token) is None:
            _LOGGER.warning("start_call for unknown session %s", session_id)
            return

        # Plain-http LAN URL — the speaker can't use the self-signed HTTPS proxy.
        base = await _async_speaker_base_url(hass)
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

    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))

    _LOGGER.info("Room Intercom set up")
    return True


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload when options (HTTPS toggle / port) change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    data = hass.data.get(DOMAIN, {})
    manager: RelayManager | None = data.get("manager")
    if manager is not None:
        await manager.close_all()

    proxy: HTTPSProxy | None = hass.data.pop(_PROXY_KEY, None)
    if proxy is not None:
        await proxy.async_stop()

    from homeassistant.components import frontend

    frontend.async_remove_panel(hass, PANEL_URL_PATH)

    hass.services.async_remove(DOMAIN, SERVICE_START_CALL)
    hass.services.async_remove(DOMAIN, SERVICE_STOP_CALL)
    hass.data.pop(DOMAIN, None)
    return True
