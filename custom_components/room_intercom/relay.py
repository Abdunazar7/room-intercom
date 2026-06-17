"""Audio relay: receives raw PCM from the browser, transcodes to MP3 with the
ffmpeg that ships inside Home Assistant Core, and broadcasts the MP3 stream to
any speaker that pulls the stream URL.

No Icecast, no external server — everything runs inside HA Core.
"""

from __future__ import annotations

import asyncio
import logging

from .const import INPUT_CHANNELS, INPUT_SAMPLE_RATE

_LOGGER = logging.getLogger(__name__)

# Read chunk size for ffmpeg stdout (bytes).
_READ_SIZE = 4096
# Per-subscriber queue depth — drop frames if a speaker can't keep up.
_QUEUE_MAXSIZE = 256


def _ffmpeg_args() -> list[str]:
    """Build ffmpeg args: raw s16le PCM in -> low-latency MP3 out."""
    return [
        "-hide_banner",
        "-loglevel",
        "error",
        # input: raw PCM from the browser
        "-f",
        "s16le",
        "-ar",
        str(INPUT_SAMPLE_RATE),
        "-ac",
        str(INPUT_CHANNELS),
        "-i",
        "pipe:0",
        # output: MP3 stream the LinkPlay/Arylic speaker can play from a URL
        "-f",
        "mp3",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-flush_packets",
        "1",
        "pipe:1",
    ]


class Session:
    """One live talk session: one ffmpeg process, many speaker subscribers."""

    def __init__(self, manager: "RelayManager", session_id: str, token: str) -> None:
        self._manager = manager
        self.id = session_id
        self.token = token
        self._proc: asyncio.subprocess.Process | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._pump_task: asyncio.Task | None = None
        self._closed = False
        self._start_lock = asyncio.Lock()

    async def start(self, ffmpeg_bin: str) -> None:
        async with self._start_lock:
            if self._proc is not None or self._closed:
                return
            self._proc = await asyncio.create_subprocess_exec(
                ffmpeg_bin,
                *_ffmpeg_args(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            self._pump_task = asyncio.create_task(self._pump_stdout())
            _LOGGER.debug("intercom session %s started", self.id)

    async def _pump_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while True:
                chunk = await self._proc.stdout.read(_READ_SIZE)
                if not chunk:
                    break
                for queue in list(self._subscribers):
                    if queue.full():
                        try:
                            queue.get_nowait()  # drop oldest, stay live
                        except asyncio.QueueEmpty:
                            pass
                    queue.put_nowait(chunk)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("intercom session %s stdout ended: %s", self.id, err)
        finally:
            for queue in list(self._subscribers):
                queue.put_nowait(None)  # EOF sentinel

    async def feed(self, data: bytes) -> None:
        """Write raw PCM from the browser into ffmpeg stdin."""
        proc = self._proc
        if proc is None or proc.stdin is None or proc.stdin.is_closing():
            return
        try:
            proc.stdin.write(data)
            await proc.stdin.drain()
        except (ConnectionResetError, BrokenPipeError, RuntimeError):
            pass

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        proc = self._proc
        if proc is not None:
            try:
                if proc.stdin is not None and not proc.stdin.is_closing():
                    proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        if self._pump_task is not None:
            self._pump_task.cancel()
        for queue in list(self._subscribers):
            queue.put_nowait(None)
        self._subscribers.clear()
        self._manager.remove(self.id)
        _LOGGER.debug("intercom session %s closed", self.id)


class RelayManager:
    """Owns all live sessions for one config entry."""

    def __init__(self, ffmpeg_bin: str) -> None:
        self._ffmpeg_bin = ffmpeg_bin
        self._sessions: dict[str, Session] = {}

    async def get_or_create(self, session_id: str, token: str) -> Session | None:
        existing = self._sessions.get(session_id)
        if existing is not None:
            return existing if existing.token == token else None
        session = Session(self, session_id, token)
        self._sessions[session_id] = session
        await session.start(self._ffmpeg_bin)
        return session

    def get(self, session_id: str, token: str | None = None) -> Session | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        if token is not None and session.token != token:
            return None
        return session

    def remove(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    async def close_all(self) -> None:
        for session in list(self._sessions.values()):
            await session.close()
