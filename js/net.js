// WebRTC transport over PeerJS. Star topology: clients connect to the host.
// The host's peer id is deterministic from the room code so clients can find
// it without any signalling server of our own (PeerJS's free broker handles
// only the connection handshake; game data flows peer-to-peer).

import { PEER_PREFIX } from "./protocol.js";

/* global Peer */

const PEER_OPTS = { debug: 1 };

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
  }

  // Resolves once the broker has registered our deterministic id.
  open() {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(hostPeerId(this.code), PEER_OPTS);
      this.peer.on("open", () => resolve());
      this.peer.on("error", (err) => {
        if (err.type === "unavailable-id") reject(new Error("CODE_TAKEN"));
        else if (this.peer.open) console.warn("peer error", err);
        else reject(err);
      });
      this.peer.on("connection", (conn) => this._wire(conn));
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
    this._retry = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(PEER_OPTS);
      this.peer.on("open", () => {
        this._dial(resolve, reject);
      });
      this.peer.on("error", (err) => {
        if (err.type === "peer-unavailable") {
          reject(new Error("HOST_NOT_FOUND"));
        } else if (!this.peer.open) {
          reject(err);
        }
      });
    });
  }

  _dial(resolve, reject) {
    const conn = this.peer.connect(hostPeerId(this.code), { reliable: true });
    this.conn = conn;
    const timeout = setTimeout(() => {
      if (!conn.open) reject(new Error("HOST_NOT_FOUND"));
    }, 8000);

    conn.on("open", () => {
      clearTimeout(timeout);
      this._retry = 0;
      this.onOpen();
      if (resolve) { resolve(); resolve = null; }
    });
    conn.on("data", (data) => this.onMessage(data));
    conn.on("close", () => {
      this.onClose();
      if (!this._closedByUs) this._reconnect();
    });
    conn.on("error", () => {
      if (reject && !conn.open) { clearTimeout(timeout); reject(new Error("HOST_NOT_FOUND")); reject = null; }
    });
  }

  // Auto-reconnect to the host (e.g. after a transient drop or host refresh).
  _reconnect() {
    if (this._closedByUs || this._retry > 12) return;
    this._retry += 1;
    const delay = Math.min(1000 * this._retry, 5000);
    setTimeout(() => {
      if (this._closedByUs) return;
      try { this._dial(null, () => {}); } catch (_) {}
    }, delay);
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  destroy() {
    this._closedByUs = true;
    try { this.peer && this.peer.destroy(); } catch (_) {}
  }
}
