// WebRTC transport over PeerJS. Star topology: clients connect to the host.
// The host's peer id is deterministic from the room code so clients can find
// it without any signalling server of our own (PeerJS's free broker handles
// only the connection handshake; game data flows peer-to-peer).

import { PEER_PREFIX } from "./protocol.js?v=20";

/* global Peer */

// ICE servers for NAT traversal. We use multiple public STUN servers.
// NOTE: the previous free TURN relay (OpenRelay) was shut down; a dead TURN
// entry can slow down / disrupt ICE on some networks, so it's removed. For
// guaranteed connectivity across strict/mobile NATs, plug a working TURN
// (e.g. Metered free tier or self-hosted coturn) into ICE_SERVERS.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const PEER_OPTS = { debug: 1, config: { iceServers: ICE_SERVERS } };

export function hostPeerId(code) {
  return PEER_PREFIX + code;
}

// ---- Host side ----------------------------------------------------------

export class HostNet {
  constructor(code) {
    this.code = code;
    this.peer = null;
    this.conns = new Map(); // connId -> DataConnection
    this.onMessage = () => {};
    this.onDisconnect = () => {};
    this._destroyed = false;
    this._onVisible = () => {
      // Mobile browsers suspend background tabs and the broker drops us;
      // re-register as soon as the host returns so new players can join.
      if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
        try { this.peer.reconnect(); } catch (_) {}
      }
    };
  }

  // Resolves once the broker has registered our deterministic id.
  open() {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(hostPeerId(this.code), PEER_OPTS);
      this.peer.on("open", () => resolve());
      this.peer.on("connection", (conn) => this._wire(conn));
      this.peer.on("disconnected", () => {
        // Broker dropped the signalling socket but our id is still ours.
        // Re-register so the room stays findable; existing data channels live.
        if (!this._destroyed) { try { this.peer.reconnect(); } catch (_) {} }
      });
      this.peer.on("error", (err) => {
        if (err.type === "unavailable-id") reject(new Error("CODE_TAKEN"));
        else if (this.peer && this.peer.open) console.warn("host peer error", err);
        else reject(err);
      });
      document.addEventListener("visibilitychange", this._onVisible);
    });
  }

  _wire(conn) {
    const id = conn.peer;
    conn.on("open", () => {
      this.conns.set(id, conn);
    });
    conn.on("data", (data) => this.onMessage(id, data));
    conn.on("close", () => {
      this.conns.delete(id);
      this.onDisconnect(id);
    });
    conn.on("error", () => {
      this.conns.delete(id);
      this.onDisconnect(id);
    });
  }

  send(connId, msg) {
    const conn = this.conns.get(connId);
    if (conn && conn.open) conn.send(msg);
  }

  broadcast(msg) {
    for (const conn of this.conns.values()) if (conn.open) conn.send(msg);
  }

  destroy() {
    this._destroyed = true;
    document.removeEventListener("visibilitychange", this._onVisible);
    try { this.peer && this.peer.destroy(); } catch (_) {}
  }
}

// ---- Client side ---------------------------------------------------------

export class ClientNet {
  constructor(code) {
    this.code = code;
    this.peer = null;
    this.conn = null;
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
    this._closedByUs = false;
    this._resolve = null;
    this._reject = null;
    this._dialAttempts = 0;     // attempts for the very first connection
    this._onVisible = () => {
      if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
        try { this.peer.reconnect(); } catch (_) {}
      }
    };
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this.peer = new Peer(PEER_OPTS);
      this.peer.on("open", () => this._attemptDial());
      this.peer.on("disconnected", () => {
        if (!this._closedByUs) { try { this.peer.reconnect(); } catch (_) {} }
      });
      this.peer.on("error", (err) => this._onPeerError(err));
      document.addEventListener("visibilitychange", this._onVisible);
    });
  }

  _onPeerError(err) {
    // The host id may not be registered yet (propagation) or the broker
    // momentarily lost it — retry a few times before giving up.
    if (err.type === "peer-unavailable") {
      this._retryInitialDial();
    } else if (this._reject && this.peer && !this.peer.open) {
      this._fail(err);
    } else {
      console.warn("client peer error", err);
    }
  }

  _attemptDial() {
    this._dialAttempts += 1;
    const conn = this.peer.connect(hostPeerId(this.code), { reliable: true });
    this.conn = conn;

    const timeout = setTimeout(() => {
      if (!conn.open) this._retryInitialDial();
    }, 6000);

    conn.on("open", () => {
      clearTimeout(timeout);
      this._dialAttempts = 0;
      this.onOpen();
      if (this._resolve) { this._resolve(); this._resolve = null; this._reject = null; }
    });
    conn.on("data", (data) => this.onMessage(data));
    conn.on("close", () => {
      this.onClose();
      if (!this._closedByUs) this._reconnect();
    });
    conn.on("error", () => {
      if (!conn.open) { clearTimeout(timeout); this._retryInitialDial(); }
    });
  }

  // Retry the FIRST connection (room not found yet / transient broker issue).
  // Deduped so the peer-error, conn-error and timeout paths can't stack.
  _retryInitialDial() {
    if (this._closedByUs || !this._reject) return; // already connected or torn down
    if (this._retryScheduled) return;
    if (this._dialAttempts >= 6) { this._fail(new Error("HOST_NOT_FOUND")); return; }
    this._retryScheduled = true;
    const delay = Math.min(1000 * this._dialAttempts, 4000);
    setTimeout(() => {
      this._retryScheduled = false;
      if (this._closedByUs || !this._reject) return;
      try { this._attemptDial(); } catch (_) {}
    }, delay);
  }

  _fail(err) {
    if (this._reject) { this._reject(err); this._reject = null; this._resolve = null; }
  }

  // Auto-reconnect after an established connection drops (host refresh, etc.).
  _reconnect() {
    if (this._closedByUs) return;
    this._reconnTries = (this._reconnTries || 0) + 1;
    if (this._reconnTries > 30) return;
    const delay = Math.min(1000 * this._reconnTries, 5000);
    setTimeout(() => {
      if (this._closedByUs) return;
      if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
        try { this.peer.reconnect(); } catch (_) {}
      }
      try {
        const conn = this.peer.connect(hostPeerId(this.code), { reliable: true });
        this.conn = conn;
        conn.on("open", () => { this._reconnTries = 0; this.onOpen(); });
        conn.on("data", (data) => this.onMessage(data));
        conn.on("close", () => { this.onClose(); if (!this._closedByUs) this._reconnect(); });
        conn.on("error", () => {});
      } catch (_) {}
    }, delay);
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  destroy() {
    this._closedByUs = true;
    document.removeEventListener("visibilitychange", this._onVisible);
    try { this.peer && this.peer.destroy(); } catch (_) {}
  }
}
