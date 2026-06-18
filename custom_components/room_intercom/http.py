"""HTTP views for the Room Intercom relay.

Both endpoints are unauthenticated on purpose: the browser opens a WebSocket
and the speaker opens an HTTP GET, and neither can carry a Home Assistant
session. Access is gated by a random per-session token instead. Playback to a
speaker can only be *started* via the authenticated `room_intercom.start_call`
service, so an attacker would also need an HA login to be heard.
"""

from __future__ import annotations

import asyncio
import logging

from aiohttp import web

from homeassistant.components.http import HomeAssistantView

from .const import STREAM_PATH, WS_UPLOAD_PATH
from .relay import RelayManager

_LOGGER = logging.getLogger(__name__)


class IntercomUploadView(HomeAssistantView):
    """WebSocket endpoint the browser pushes raw PCM into."""

    url = WS_UPLOAD_PATH
    name = "api:room_intercom:ws"
    requires_auth = False

    def __init__(self, manager: RelayManager) -> None:
        self._manager = manager

    async def get(self, request: web.Request) -> web.StreamResponse:
        session_id = request.query.get("session")
        token = request.query.get("token")
        if not session_id or not token:
            return web.Response(status=400, text="missing session/token")

        ws = web.WebSocketResponse(max_msg_size=0, heartbeat=30)
        await ws.prepare(request)

        session = await self._manager.get_or_create(session_id, token)
        if session is None:
            await ws.close(code=4403, message=b"token mismatch")
            return ws

        # Tell the browser the session exists so it can safely call start_call.
        # Without this, through the HTTPS proxy start_call can race ahead of
        # session creation ("start_call for unknown session").
        try:
            await ws.send_str("ready")
        except Exception:  # noqa: BLE001
            pass

        # When the speaker actually connects to the stream, let the browser know
        # so it can show "speak now" at the right moment.
        notify = asyncio.create_task(self._notify_playing(ws, session))

        try:
            async for msg in ws:
                if msg.type == web.WSMsgType.BINARY:
                    await session.feed(msg.data)
                elif msg.type == web.WSMsgType.TEXT:
                    if msg.data == "stop":
                        break
                elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                    break
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("intercom upload ws error: %s", err)
        finally:
            notify.cancel()
            # User released / disconnected: flush ffmpeg and let the speaker play
            # the tail to the end instead of being cut off.
            await session.finish()
        return ws

    @staticmethod
    async def _notify_playing(ws: web.WebSocketResponse, session) -> None:
        try:
            await session.wait_first_subscriber()
            if not ws.closed:
                await ws.send_str("playing")
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            pass


class IntercomStreamView(HomeAssistantView):
    """HTTP endpoint the speaker pulls the live MP3 stream from."""

    url = STREAM_PATH
    name = "api:room_intercom:stream"
    requires_auth = False

    def __init__(self, manager: RelayManager) -> None:
        self._manager = manager

    async def get(self, request: web.Request) -> web.StreamResponse:
        session_id = request.query.get("session")
        token = request.query.get("token")
        if not session_id or not token:
            return web.Response(status=400, text="missing session/token")

        session = self._manager.get(session_id, token)
        if session is None:
            return web.Response(status=404, text="no such session")

        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "audio/mpeg",
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Connection": "close",
            },
        )
        response.enable_chunked_encoding()
        await response.prepare(request)

        queue = session.subscribe()
        try:
            while True:
                chunk = await queue.get()
                if chunk is None:  # EOF
                    break
                await response.write(chunk)
        except (asyncio.CancelledError, ConnectionResetError, ConnectionError):
            pass
        finally:
            session.unsubscribe(queue)
        return response
