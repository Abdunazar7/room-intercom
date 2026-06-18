# Room Intercom for Home Assistant

Push-to-talk intercom from a Home Assistant dashboard (e.g. a wall tablet in
Fully Kiosk) to **any `media_player` speaker** — Arylic / LinkPlay, Yamaha,
Bose, Sonos, anything HA can `play_media` to.

Hold a button on the dashboard, talk into the tablet's microphone, and your
voice comes out of the chosen speaker(s). Perfect for calling someone on
another floor.

* **Nothing is installed on the HA host.** No Icecast, no Node.js, no manual
  add-on. The relay runs inside Home Assistant Core using the `ffmpeg` that
  already ships with it.
* **Nothing is hardcoded.** No access token, no IP/port, no entity ids baked
  in. The stream URL is derived from HA's own network config and the target
  speakers are chosen in the card. Install it on any HA instance.
* **One card, two layouts.** A single per-room button, or one button with a
  list of rooms and toggles to pick which speakers play.

## How it works

```
[Tablet / Fully Kiosk]  mic (Web Audio -> PCM16)
        │  WebSocket  (wss://<your-ha>/api/room_intercom/ws)
        ▼
[room_intercom integration]   (inside HA Core)
        │  ffmpeg: PCM -> live MP3
        │  serves  /api/room_intercom/stream
        ▼  media_player.play_media(stream URL)
[Your speaker(s)]
```

## Install (HACS, custom repository)

1. HACS → ⋮ → **Custom repositories**.
2. Add this repo URL, category **Integration**.
3. Install **Room Intercom**, then restart Home Assistant.
4. Settings → Devices & Services → **Add Integration** → **Room Intercom**
   (nothing to configure — just confirm).

A sidebar panel **Intercom** appears automatically — no dashboard editing
needed. The Lovelace card below is optional, for embedding the button in your
own views.

## The auto panel (easiest)

After setup, open **Intercom** in the sidebar. It auto-discovers every speaker
that supports "play media", lists them with toggles, and gives one big button.
**Tap to talk, tap again to stop** (no press-and-hold). Whichever speakers are
toggled on play your voice.

## Use the card (optional)

Single-room button (place it inside a room view):

```yaml
type: custom:room-intercom-card
mode: single
title: Call kitchen
entity: media_player.soundsystem_ea93
volume: 0.6
```

Universal button with a room list and toggles (place it on the dashboard):

```yaml
type: custom:room-intercom-card
mode: rooms
title: Intercom
volume: 0.6
rooms:
  - name: Living room
    entity: media_player.soundsystem_ea93
    default: true
  - name: Bedroom
    entity: media_player.soundsystem_e5da
```

Tap the button to talk, tap again to stop. In `rooms` mode, whichever toggles
are on will play your voice — one, several, or all at once.

## Built-in HTTPS (microphone works out of the box)

Browsers only allow microphone capture in a **secure context** (HTTPS or
`localhost`). Plain `http://<ip>:8123` silently fails. So Room Intercom starts
its own small **HTTPS reverse proxy** (default port **8443**, self-signed
certificate generated automatically) that forwards everything to Home Assistant.
Open the dashboard via **`https://<ip>:8443`**, accept the certificate once, and
the microphone works — no add-on, no Caddy, no manual setup.

You can change the port or turn this off in
**Settings → Devices & Services → Room Intercom → Configure** (e.g. disable it if
you already terminate HTTPS with your own reverse proxy).

### Running alongside BMS Intercom (domofon)

[BMS Intercom](https://github.com/optomtr/bms-intercom) raises the same kind of
HTTPS proxy on 8443. The two coexist: **whichever integration starts first binds
the port, and the other detects it's taken and reuses it** — both proxies
forward to the same Home Assistant, so the microphone and both integrations work
through a single `https://<ip>:8443`. No conflict, nothing to configure.

## Requirements & notes

* The card uses relative URLs, so it works on whichever address you open
  (`https://<ip>:8443`, or `http://<ip>:8123` if you have HTTPS elsewhere).
* **Latency.** LinkPlay/Arylic and similar speakers buffer HTTP streams, so
  expect roughly **1–2 seconds** of delay — fine for an intercom / "come
  upstairs" call, not a phone call.
* The stream URL handed to the speaker is always a plain-http LAN address
  (Home Assistant's own IP and port, detected automatically) — speakers can't
  use the self-signed HTTPS proxy, and they don't need to.
* Speakers must support playing an HTTP MP3 stream via `media_player.play_media`
  (Arylic/LinkPlay, Sonos, Music Assistant players, etc. all do).

## Services

* `room_intercom.start_call` — point speakers at a session's stream (used by
  the card).
* `room_intercom.stop_call` — stop speakers and tear down the session.

## License

MIT
