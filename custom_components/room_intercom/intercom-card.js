/**
 * Room Intercom card
 *
 * Push-to-talk from a Home Assistant dashboard to any media_player speaker.
 * Captures the microphone, streams raw PCM to the room_intercom relay over a
 * WebSocket, and tells the chosen speakers to play the live stream.
 *
 * Two layouts from one component:
 *   mode: single  -> one button bound to one speaker (place inside a room view)
 *   mode: rooms   -> a list of speakers with toggles + one big talk button
 *
 * Config examples:
 *
 *   type: custom:room-intercom-card
 *   mode: single
 *   title: Call kitchen
 *   entity: media_player.soundsystem_ea93
 *   volume: 0.6
 *
 *   type: custom:room-intercom-card
 *   mode: rooms
 *   title: Intercom
 *   volume: 0.6
 *   rooms:
 *     - name: Living room
 *       entity: media_player.soundsystem_ea93
 *     - name: Bedroom
 *       entity: media_player.soundsystem_e5da
 *
 * URLs are relative to wherever the dashboard is opened, so the card works on
 * http://ip:8123 and https://ip:8443 with no changes. Microphone capture needs
 * a secure context — open the dashboard via HTTPS (8443) or grant the mic
 * permission in Fully Kiosk.
 */

const WS_PATH = "/api/room_intercom/ws";
const SAMPLE_RATE = 48000;
const BUFFER_SIZE = 4096;

class RoomIntercomCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._talking = false;
    this._connecting = false;
    this._session = null;
    this._token = null;
    this._ws = null;
    this._stream = null;
    this._audioCtx = null;
    this._source = null;
    this._processor = null;
    this._activeTargets = [];
    this._rendered = false;
  }

  setConfig(config) {
    const mode = config.mode || (config.rooms ? "rooms" : "single");
    if (mode === "single" && !config.entity) {
      throw new Error("room-intercom-card: 'entity' is required in single mode");
    }
    if (mode === "rooms" && (!config.rooms || !config.rooms.length)) {
      throw new Error("room-intercom-card: 'rooms' list is required in rooms mode");
    }
    this._config = { ...config, mode };
    this._rendered = false;
    if (this.shadowRoot) this._render();
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

  // ---- helpers -----------------------------------------------------------

  _rand(prefix) {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return prefix + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  _wsBase() {
    // hassUrl() returns the base the frontend is connected to, e.g.
    // https://ip:8443/ — reuse its host so we never hardcode IP/port.
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

  _selectedTargets() {
    if (this._config.mode === "single") return [this._config.entity];
    const checks = this.shadowRoot.querySelectorAll("input[data-entity]");
    const out = [];
    checks.forEach((c) => {
      if (c.checked) out.push(c.getAttribute("data-entity"));
    });
    return out;
  }

  // ---- talk lifecycle ----------------------------------------------------

  async _startTalk() {
    if (this._talking || this._connecting) return;
    const targets = this._selectedTargets();
    if (!targets.length) {
      this._setStatus("Select at least one room");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._setStatus("Mic blocked — open via HTTPS (8443)");
      return;
    }

    this._connecting = true;
    this._activeTargets = targets;
    this._session = this._rand("ic_");
    this._token = this._rand("");
    this._updateButton();
    this._setStatus("Connecting…");

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

      await new Promise((resolve, reject) => {
        this._ws.onopen = resolve;
        this._ws.onerror = () => reject(new Error("ws error"));
      });

      // Pipe mic -> PCM16 -> WebSocket.
      this._source = this._audioCtx.createMediaStreamSource(this._stream);
      this._processor = this._audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      this._processor.onaudioprocess = (ev) => {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        const input = ev.inputBuffer.getChannelData(0);
        this._ws.send(this._floatTo16BitPCM(input));
      };
      this._source.connect(this._processor);
      this._processor.connect(this._audioCtx.destination);

      // Tell the speakers to start pulling the stream.
      const data = {
        session: this._session,
        token: this._token,
        entity_id: targets,
      };
      if (this._config.volume != null) data.volume = Number(this._config.volume);
      await this._hass.callService("room_intercom", "start_call", data);

      this._connecting = false;
      this._talking = true;
      this._updateButton();
      this._setStatus("Talking…");
    } catch (err) {
      this._connecting = false;
      this._setStatus("Error: " + (err && err.message ? err.message : err));
      await this._cleanup();
      this._updateButton();
    }
  }

  async _stopTalk() {
    if (!this._talking && !this._connecting) return;
    const targets = this._activeTargets;
    const session = this._session;

    try {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send("stop");
    } catch (e) {
      /* ignore */
    }
    await this._cleanup();

    try {
      await this._hass.callService("room_intercom", "stop_call", {
        session,
        entity_id: targets,
      });
    } catch (e) {
      /* ignore */
    }

    this._talking = false;
    this._connecting = false;
    this._updateButton();
    this._setStatus("Idle");
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

  _floatTo16BitPCM(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  // ---- rendering ---------------------------------------------------------

  _setStatus(text) {
    const el = this.shadowRoot.querySelector(".status");
    if (el) el.textContent = text;
  }

  _updateButton() {
    const btn = this.shadowRoot.querySelector(".talk");
    if (!btn) return;
    btn.classList.toggle("talking", this._talking);
    btn.classList.toggle("connecting", this._connecting);
    const label = btn.querySelector(".label");
    if (label) {
      label.textContent = this._talking
        ? "Release to stop"
        : this._connecting
        ? "Connecting…"
        : "Hold to talk";
    }
  }

  _render() {
    if (!this._config || !this.shadowRoot) return;
    this._rendered = true;
    const c = this._config;
    const title = c.title || "Intercom";

    let roomsHtml = "";
    if (c.mode === "rooms") {
      roomsHtml =
        '<div class="rooms">' +
        c.rooms
          .map((r, i) => {
            const checked = r.default ? "checked" : "";
            const name = r.name || r.entity;
            return (
              `<label class="room"><input type="checkbox" data-entity="${r.entity}" ${checked}>` +
              `<span>${name}</span></label>`
            );
          })
          .join("") +
        "</div>";
    }

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        .title { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; }
        .rooms { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
        .room { display: flex; align-items: center; gap: 10px; font-size: 1rem;
                padding: 6px 4px; cursor: pointer; }
        .room input { width: 20px; height: 20px; }
        .talk {
          width: 100%; padding: 22px; border: none; border-radius: 14px;
          background: var(--primary-color); color: var(--text-primary-color, #fff);
          font-size: 1.1rem; font-weight: 600; cursor: pointer; user-select: none;
          -webkit-user-select: none; touch-action: none; transition: transform .08s, background .15s;
          display: flex; align-items: center; justify-content: center; gap: 10px;
        }
        .talk:active { transform: scale(0.98); }
        .talk.connecting { background: var(--warning-color, #ffa600); }
        .talk.talking { background: var(--error-color, #db4437); animation: pulse 1s infinite; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .75; } }
        .mic { width: 22px; height: 22px; fill: currentColor; }
        .status { margin-top: 10px; font-size: .85rem; color: var(--secondary-text-color); text-align: center; }
      </style>
      <ha-card>
        <div class="title">${title}</div>
        ${roomsHtml}
        <button class="talk">
          <svg class="mic" viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
          <span class="label">Hold to talk</span>
        </button>
        <div class="status">Idle</div>
      </ha-card>
    `;

    const btn = this.shadowRoot.querySelector(".talk");
    const start = (e) => {
      e.preventDefault();
      this._startTalk();
    };
    const stop = (e) => {
      e.preventDefault();
      this._stopTalk();
    };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("pointerleave", stop);
  }

  disconnectedCallback() {
    if (this._talking || this._connecting) this._stopTalk();
  }
}

customElements.define("room-intercom-card", RoomIntercomCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "room-intercom-card",
  name: "Room Intercom",
  description: "Push-to-talk intercom to your speakers",
  preview: false,
});

console.info("%c ROOM-INTERCOM-CARD %c loaded ", "color:#fff;background:#03a9f4", "");
