/**
 * Room Intercom — front-end
 *
 * Provides two custom elements from one file:
 *   <room-intercom-card>   a Lovelace card (single speaker or a room list)
 *   <room-intercom-panel>  a full-page sidebar panel that auto-discovers all
 *                          speakers (no dashboard editing needed)
 *
 * Tap the button to start talking, tap again to stop (no press-and-hold). The
 * microphone is streamed to the room_intercom relay over a WebSocket; on stop
 * we just close the socket and the relay flushes so the speaker plays the tail
 * to the end. URLs are relative, so it works on https://ip:8443 and
 * http://ip:8123 alike (mic needs the HTTPS one).
 */

const WS_PATH = "/api/room_intercom/ws";
const SAMPLE_RATE = 48000;
const BUFFER_SIZE = 4096;
const FEATURE_PLAY_MEDIA = 512; // MediaPlayerEntityFeature.PLAY_MEDIA

const STYLES = `
  :host { display: block; }
  .wrap { font-family: var(--paper-font-body1_-_font-family, sans-serif); }
  .title { font-size: 1.15rem; font-weight: 600; margin-bottom: 14px; }
  .rooms { display: flex; flex-direction: column; gap: 4px; margin-bottom: 18px; }
  .room {
    display: flex; align-items: center; gap: 12px; font-size: 1rem;
    padding: 10px 12px; border-radius: 12px; cursor: pointer;
    background: var(--secondary-background-color, rgba(255,255,255,.04));
    transition: background .15s;
  }
  .room:hover { background: var(--divider-color, rgba(255,255,255,.08)); }
  .room input { width: 20px; height: 20px; accent-color: var(--primary-color); margin: 0; }
  .room .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--disabled-text-color, #888); }
  .room.on .dot { background: var(--success-color, #43a047); }
  .empty { color: var(--secondary-text-color); font-size: .9rem; padding: 8px 2px 16px; }
  .talk {
    position: relative; width: 100%; padding: 26px; border: none; border-radius: 18px;
    background: var(--primary-color);
    background: linear-gradient(135deg, var(--primary-color), color-mix(in srgb, var(--primary-color) 70%, #000));
    color: var(--text-primary-color, #fff); font-size: 1.15rem; font-weight: 700;
    cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: manipulation;
    display: flex; align-items: center; justify-content: center; gap: 12px;
    box-shadow: 0 6px 20px rgba(0,0,0,.25); transition: transform .08s, filter .15s, background .2s;
  }
  .talk:active { transform: scale(0.98); }
  .talk:hover { filter: brightness(1.05); }
  .talk.connecting {
    background: var(--warning-color, #ffa600);
    background: linear-gradient(135deg, var(--warning-color, #ffa600), #c97f00);
  }
  .talk.talking {
    background: var(--error-color, #db4437);
    background: linear-gradient(135deg, var(--error-color, #db4437), #a32a20);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,100% { box-shadow: 0 6px 20px rgba(219,68,55,.35); }
    50% { box-shadow: 0 6px 34px rgba(219,68,55,.85); }
  }
  .mic { width: 26px; height: 26px; fill: currentColor; }
  .status {
    margin-top: 12px; font-size: .9rem; color: var(--secondary-text-color);
    text-align: center; min-height: 1.2em;
  }
  .status.live { color: var(--error-color, #db4437); font-weight: 600; }
`;

const MIC_SVG = `<svg class="mic" viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`;

/** Shared microphone + relay logic. Subclasses provide _getTargets(). */
class IntercomBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._talking = false;
    this._connecting = false;
    this._volume = null;
    this._session = null;
    this._token = null;
    this._ws = null;
    this._stream = null;
    this._audioCtx = null;
    this._source = null;
    this._processor = null;
  }

  _getTargets() {
    return [];
  }

  _rand(prefix) {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return prefix + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  _wsBase() {
    let base;
    try {
      base = this._hass && this._hass.hassUrl ? this._hass.hassUrl() : location.origin;
    } catch (e) {
      base = location.origin;
    }
    const url = new URL(base, location.origin);
    const proto = url.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${url.host}`;
  }

  _floatTo16BitPCM(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  _toggle() {
    if (this._talking || this._connecting) this._stopTalk();
    else this._startTalk();
  }

  async _startTalk() {
    if (this._talking || this._connecting) return;
    const targets = this._getTargets();
    if (!targets.length) {
      this._setStatus("Select at least one room", false);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._setStatus("Mic blocked — open the dashboard over HTTPS (:8443)", false);
      return;
    }

    this._connecting = true;
    this._session = this._rand("ic_");
    this._token = this._rand("");
    this._updateButton();
    this._setStatus("Connecting…", false);

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AudioCtx({ sampleRate: SAMPLE_RATE });
      if (this._audioCtx.state === "suspended") await this._audioCtx.resume();

      const wsUrl =
        `${this._wsBase()}${WS_PATH}` +
        `?session=${encodeURIComponent(this._session)}` +
        `&token=${encodeURIComponent(this._token)}`;
      this._ws = new WebSocket(wsUrl);
      this._ws.binaryType = "arraybuffer";

      // Resolve when the relay confirms the session is ready (see http.py).
      let onReady;
      const ready = new Promise((res) => (onReady = res));
      this._ws.onmessage = (ev) => {
        if (ev.data === "ready") onReady();
      };

      await new Promise((resolve, reject) => {
        this._ws.onopen = resolve;
        this._ws.onerror = () => reject(new Error("connection failed"));
      });

      // Wait for the "ready" handshake before telling speakers to connect, so
      // start_call never races ahead of session creation (proxy adds a hop).
      await Promise.race([ready, new Promise((r) => setTimeout(r, 2500))]);

      this._source = this._audioCtx.createMediaStreamSource(this._stream);
      this._processor = this._audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      this._processor.onaudioprocess = (ev) => {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        this._ws.send(this._floatTo16BitPCM(ev.inputBuffer.getChannelData(0)));
      };
      this._source.connect(this._processor);
      this._processor.connect(this._audioCtx.destination);

      const data = { session: this._session, token: this._token, entity_id: targets };
      if (this._volume != null) data.volume = Number(this._volume);
      await this._hass.callService("room_intercom", "start_call", data);

      this._connecting = false;
      this._talking = true;
      this._updateButton();
      this._setStatus("● Talking — tap to stop", true);
    } catch (err) {
      this._connecting = false;
      this._setStatus("Error: " + (err && err.message ? err.message : err), false);
      await this._cleanup();
      this._updateButton();
    }
  }

  async _stopTalk() {
    if (!this._talking && !this._connecting) return;
    // Tell the relay we're done so it flushes and the speaker plays the tail,
    // then close the socket. No media_stop — that would cut the end off.
    try {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send("stop");
    } catch (e) {
      /* ignore */
    }
    await this._cleanup();
    this._talking = false;
    this._connecting = false;
    this._updateButton();
    this._setStatus("Idle", false);
  }

  async _cleanup() {
    if (this._processor) {
      try {
        this._processor.disconnect();
        this._processor.onaudioprocess = null;
      } catch (e) {}
      this._processor = null;
    }
    if (this._source) {
      try {
        this._source.disconnect();
      } catch (e) {}
      this._source = null;
    }
    if (this._audioCtx) {
      try {
        await this._audioCtx.close();
      } catch (e) {}
      this._audioCtx = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch (e) {}
      this._ws = null;
    }
  }

  _setStatus(text, live) {
    const el = this.shadowRoot.querySelector(".status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("live", !!live);
  }

  _updateButton() {
    const btn = this.shadowRoot.querySelector(".talk");
    if (!btn) return;
    btn.classList.toggle("talking", this._talking);
    btn.classList.toggle("connecting", this._connecting);
    const label = btn.querySelector(".label");
    if (label) {
      label.textContent = this._talking
        ? "Stop"
        : this._connecting
        ? "Connecting…"
        : "Talk";
    }
  }

  _bindButton() {
    const btn = this.shadowRoot.querySelector(".talk");
    if (btn) btn.addEventListener("click", () => this._toggle());
  }

  disconnectedCallback() {
    if (this._talking || this._connecting) this._stopTalk();
  }
}

/** Lovelace card: mode "single" (one speaker) or "rooms" (toggle list). */
class RoomIntercomCard extends IntercomBase {
  setConfig(config) {
    const mode = config.mode || (config.rooms ? "rooms" : "single");
    if (mode === "single" && !config.entity) {
      throw new Error("room-intercom-card: 'entity' is required in single mode");
    }
    if (mode === "rooms" && (!config.rooms || !config.rooms.length)) {
      throw new Error("room-intercom-card: 'rooms' list is required in rooms mode");
    }
    this._config = { ...config, mode };
    this._volume = config.volume != null ? config.volume : null;
    this._rendered = false;
    if (this.shadowRoot && this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) this._render();
  }

  getCardSize() {
    return this._config && this._config.mode === "rooms"
      ? 2 + (this._config.rooms.length || 0)
      : 2;
  }

  _getTargets() {
    if (this._config.mode === "single") return [this._config.entity];
    const out = [];
    this.shadowRoot.querySelectorAll("input[data-entity]").forEach((c) => {
      if (c.checked) out.push(c.getAttribute("data-entity"));
    });
    return out;
  }

  _render() {
    if (!this._config || !this.shadowRoot) return;
    this._rendered = true;
    const c = this._config;
    const title = c.title || "Intercom";

    let rooms = "";
    if (c.mode === "rooms") {
      rooms =
        '<div class="rooms">' +
        c.rooms
          .map((r) => {
            const checked = r.default ? "checked" : "";
            const name = r.name || r.entity;
            return (
              `<label class="room ${checked ? "on" : ""}">` +
              `<input type="checkbox" data-entity="${r.entity}" ${checked}>` +
              `<span class="dot"></span><span>${name}</span></label>`
            );
          })
          .join("") +
        "</div>";
    }

    this.shadowRoot.innerHTML = `
      <style>${STYLES} ha-card { padding: 16px; }</style>
      <ha-card><div class="wrap">
        <div class="title">${title}</div>
        ${rooms}
        <button class="talk">${MIC_SVG}<span class="label">Talk</span></button>
        <div class="status">Idle</div>
      </div></ha-card>
    `;

    this.shadowRoot.querySelectorAll(".room").forEach((row) => {
      const input = row.querySelector("input");
      input.addEventListener("change", () => row.classList.toggle("on", input.checked));
    });
    this._bindButton();
  }
}

/** Full-page sidebar panel — auto-discovers every speaker, one talk button. */
class RoomIntercomPanel extends IntercomBase {
  constructor() {
    super();
    this._rendered = false;
    this._volume = 0.6;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) this._render();
  }
  set narrow(v) {}
  set route(v) {}
  set panel(p) {
    this._panel = p;
    // Config (selected speakers) may arrive after hass — re-render once if idle.
    if (this._rendered && !this._talking && !this._connecting) {
      this._rendered = false;
      this._render();
    }
  }

  _speakerList() {
    const hass = this._hass;
    if (!hass || !hass.states) return [];
    const cfg = this._panel && this._panel.config;
    const chosen = cfg && Array.isArray(cfg.speakers) ? cfg.speakers : null;

    if (chosen && chosen.length) {
      // Only the speakers picked in the integration options, in that order.
      return chosen.map((id) => ({
        entity: id,
        name: (hass.states[id] && hass.states[id].attributes.friendly_name) || id,
      }));
    }

    // Nothing configured yet → auto-discover everything that can play media.
    return Object.values(hass.states)
      .filter(
        (s) =>
          s.entity_id.startsWith("media_player.") &&
          (Number(s.attributes.supported_features) || 0) & FEATURE_PLAY_MEDIA
      )
      .map((s) => ({
        entity: s.entity_id,
        name: s.attributes.friendly_name || s.entity_id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _getTargets() {
    const out = [];
    this.shadowRoot.querySelectorAll("input[data-entity]").forEach((c) => {
      if (c.checked) out.push(c.getAttribute("data-entity"));
    });
    return out;
  }

  _render() {
    if (!this._hass || !this.shadowRoot) return;
    this._rendered = true;
    const speakers = this._speakerList();

    let list;
    if (!speakers.length) {
      list = `<div class="empty">No speakers found. Pick them in Settings →
        Devices &amp; Services → Room Intercom → Configure, or add a media player
        that supports "play media".</div>`;
    } else {
      list =
        '<div class="rooms">' +
        speakers
          .map((s, i) => {
            const checked = i === 0 ? "checked" : "";
            return (
              `<label class="room ${checked ? "on" : ""}">` +
              `<input type="checkbox" data-entity="${s.entity}" ${checked}>` +
              `<span class="dot"></span><span>${s.name}</span></label>`
            );
          })
          .join("") +
        "</div>";
    }

    this.shadowRoot.innerHTML = `
      <style>
        ${STYLES}
        .page { min-height: 100%; display: flex; align-items: flex-start; justify-content: center;
                padding: 28px 16px; box-sizing: border-box; }
        .panel-card {
          width: 100%; max-width: 460px; background: var(--card-background-color, #1c1c1c);
          border-radius: 20px; padding: 24px; box-shadow: 0 8px 30px rgba(0,0,0,.35);
        }
        .head { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
        .head .hmic { width: 28px; height: 28px; fill: var(--primary-color); }
        .head .htitle { font-size: 1.35rem; font-weight: 700; }
      </style>
      <div class="wrap page">
        <div class="panel-card">
          <div class="head">
            <svg class="hmic" viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
            <div class="htitle">Intercom</div>
          </div>
          ${list}
          <button class="talk">${MIC_SVG}<span class="label">Talk</span></button>
          <div class="status">Idle</div>
        </div>
      </div>
    `;

    this.shadowRoot.querySelectorAll(".room").forEach((row) => {
      const input = row.querySelector("input");
      input.addEventListener("change", () => row.classList.toggle("on", input.checked));
    });
    this._bindButton();
  }
}

if (!customElements.get("room-intercom-card")) {
  customElements.define("room-intercom-card", RoomIntercomCard);
}
if (!customElements.get("room-intercom-panel")) {
  customElements.define("room-intercom-panel", RoomIntercomPanel);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "room-intercom-card")) {
  window.customCards.push({
    type: "room-intercom-card",
    name: "Room Intercom",
    description: "Push-to-talk intercom to your speakers",
    preview: false,
  });
}

console.info("%c ROOM-INTERCOM %c card+panel loaded ", "color:#fff;background:#03a9f4", "");
