// App bootstrap. Decides whether this tab is a host (runs the engine) or a
// client (talks to a host), wires the transport, and translates server
// messages into store updates that the UI renders.

import { store } from "./store.js?v=16";
import { actions } from "./actions.js?v=16";
import { initUI } from "./ui.js?v=16";
import { GameEngine } from "./engine.js?v=16";
import { HostNet, ClientNet } from "./net.js?v=16";
import { C, S, STATUS } from "./protocol.js?v=16";
import { randomCode, sessionToken as makeToken } from "./util.js?v=16";

const LOCAL = "LOCAL"; // sentinel connId for the host's own player
const SESSION_KEY = "dr_session";
const SNAPSHOT_KEY = "dr_host_snapshot";
const SNAPSHOT_TTL = 2 * 60 * 60 * 1000;

let role = null;        // "host" | "client"
let engine = null;
let hostNet = null;
let clientNet = null;
let myProfile = null;
let mySessionToken = null;

// ---- server-message handling (shared by host-local & client) ------------

function handleServerMessage(msg) {
  const s = store.get();
  switch (msg.t) {
    case S.JOINED: {
      mySessionToken = msg.sessionToken;
      persistSession();
      store.set({ me: msg.you });
      break;
    }
    case S.ROOM_STATE: {
      const room = msg.room;
      const me = s.me ? room.players.find((p) => p.id === s.me.id) || s.me : s.me;
      const patch = { room, me, isHost: !!(me && me.isHost), roomCode: room.roomCode };
      if (room.status === STATUS.LOBBY) {
        patch.screen = "lobby";
        patch.round = null;
        patch.reveal = null;
        patch.present = null;
      } else if (room.status === STATUS.PLAYING && (s.screen === "lobby" || s.screen === "home")) {
        patch.screen = "waiting";
      }
      store.set(patch);
      break;
    }
    case S.ROUND_STARTED: {
      store.set({
        round: msg,
        submitted: !!msg.alreadySubmitted,
        screen: msg.alreadySubmitted ? "waiting" : "round",
      });
      break;
    }
    case S.ROUND_PROGRESS: {
      store.set({ progress: { submitted: msg.submitted, total: msg.total } });
      break;
    }
    case S.ROUND_ENDED: {
      if (store.get().screen === "round" && !store.get().submitted) {
        store.set({ screen: "waiting" });
      }
      break;
    }
    case S.REVEAL_STARTED: {
      store.set({ screen: "reveal", reveal: msg.chains, round: null, present: { index: 0, playing: true } });
      break;
    }
    case S.PRESENT_STEP: {
      store.set({ screen: "reveal", present: { index: msg.index, playing: msg.playing } });
      break;
    }
    case S.REACTION_NEW: {
      const reveal = (store.get().reveal || []).map((c) => {
        if (c.id !== msg.chainId) return c;
        return {
          ...c,
          entries: c.entries.map((e) =>
            e.id === msg.entryId
              ? { ...e, reactions: { ...e.reactions, [msg.emoji]: msg.count } }
              : e),
        };
      });
      store.set({ reveal });
      break;
    }
    case S.ERROR: {
      store.set({ error: msg.message });
      setTimeout(() => store.set({ error: null }), 3500);
      break;
    }
    case S.KICKED: {
      clearSession();
      store.set({ error: "You were removed from the room." });
      setTimeout(() => actions.leaveRoom(), 300);
      break;
    }
    case S.HOST_CLOSED: {
      store.set({ hostClosed: true, connStatus: "offline" });
      break;
    }
  }
}

// ---- host role ----------------------------------------------------------

function makeHostTransport() {
  return {
    send(connId, msg) {
      if (connId === LOCAL) handleServerMessage(msg);
      else hostNet.send(connId, msg);
    },
    broadcast(msg) {
      hostNet.broadcast(msg);
      handleServerMessage(msg); // deliver to the host's own player view
    },
  };
}

function saveSnapshot(snap) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap)); } catch (_) {}
}

async function startHost(code, profile, restoreSnap = null) {
  role = "host";
  myProfile = profile;
  store.set({ connecting: true, roomCode: code, isHost: true, hostClosed: false, error: null, connStatus: "connecting" });

  hostNet = new HostNet(code);
  engine = new GameEngine({
    roomCode: code,
    transport: makeHostTransport(),
    settings: restoreSnap ? restoreSnap.settings : {},
    onSnapshot: saveSnapshot,
  });

  hostNet.onMessage = (connId, data) => engine.handleClientMessage(connId, data);
  hostNet.onDisconnect = (connId) => engine.markDisconnected(connId);

  try {
    await hostNet.open();
  } catch (err) {
    store.set({ connecting: false });
    if (err.message === "CODE_TAKEN") return startHost(randomCode(), profile);
    store.set({ error: "Δεν άνοιξε το δωμάτιο. Έλεγξε τη σύνδεσή σου.", connStatus: "offline" });
    return;
  }
  store.set({ connStatus: "host" });

  if (restoreSnap) {
    engine.restore(restoreSnap);
    // Re-attach the host's own player and resync its view.
    const hp = engine.players.find((p) => p.id === engine.hostPlayerId);
    if (hp) { hp.connId = LOCAL; hp.isConnected = true; }
    persistSession();
    store.set({ connecting: false });
    engine.resyncPlayer(engine.hostPlayerId);
  } else {
    mySessionToken = makeToken();
    persistSession();
    store.set({ connecting: false });
    engine.handleClientMessage(LOCAL, {
      t: C.JOIN, nickname: profile.nickname, avatarColor: profile.avatarColor,
      sessionToken: mySessionToken, isHost: true,
    });
  }
  location.hash = code;
}

// ---- client role --------------------------------------------------------

async function startClient(code, profile) {
  role = "client";
  myProfile = profile;
  store.set({ connecting: true, roomCode: code, isHost: false, hostClosed: false, error: null, connStatus: "connecting" });

  clientNet = new ClientNet(code);
  clientNet.onMessage = (data) => handleServerMessage(data);
  clientNet.onOpen = () => {
    store.set({ connecting: false, hostClosed: false, connStatus: "connected" });
    clientNet.send({
      t: C.JOIN, nickname: profile.nickname, avatarColor: profile.avatarColor,
      sessionToken: mySessionToken || undefined,
    });
  };
  clientNet.onClose = () => { store.set({ connStatus: "reconnecting" }); };

  try {
    await clientNet.connect();
  } catch (err) {
    store.set({ connecting: false, connStatus: "offline" });
    store.set({ error: err.message === "HOST_NOT_FOUND"
      ? "Δεν βρέθηκε το δωμάτιο. Έλεγξε τον κωδικό και ότι ο host έχει ανοιχτό το παιχνίδι."
      : "Η σύνδεση απέτυχε. Δοκίμασε ξανά." });
    role = null;
    clientNet.destroy(); clientNet = null;
  }
}

// ---- session persistence / recovery -------------------------------------

function persistSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      role, code: store.get().roomCode, sessionToken: mySessionToken,
      profile: myProfile, savedAt: Date.now(),
    }));
  } catch (_) {}
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SNAPSHOT_KEY);
}

function tryResume() {
  let session;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return false; }
  if (!session || Date.now() - session.savedAt > SNAPSHOT_TTL) return false;
  mySessionToken = session.sessionToken;

  if (session.role === "host") {
    let snap;
    try { snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)); } catch { snap = null; }
    const resumable = snap && (snap.status === STATUS.PLAYING || snap.status === STATUS.REVEALING || snap.status === STATUS.FINISHED);
    if (resumable && snap.roomCode === session.code && Date.now() - snap.savedAt < SNAPSHOT_TTL) {
      startHost(session.code, session.profile, snap);
      return true;
    }
    // Stale or lobby-only snapshot — start clean from home instead.
    clearSession();
    return false;
  }
  if (session.role === "client" && session.code) {
    startClient(session.code, session.profile);
    return true;
  }
  return false;
}

// ---- wire actions --------------------------------------------------------

actions.createRoom = (profile) => { clearSession(); startHost(randomCode(), profile); };
actions.joinRoom = (code, profile) => { startClient(code, profile); };
actions.sendToHost = (msg) => {
  if (role === "host") engine.handleClientMessage(LOCAL, msg);
  else if (clientNet) clientNet.send(msg);
};
actions.leaveRoom = () => {
  actions.sendToHost({ t: C.LEAVE });
  if (role === "host" && hostNet) { hostNet.broadcast({ t: S.HOST_CLOSED }); hostNet.destroy(); }
  if (clientNet) clientNet.destroy();
  clearSession();
  role = null; engine = null; hostNet = null; clientNet = null; mySessionToken = null;
  location.hash = "";
  store.set({
    screen: "home", isHost: false, roomCode: null, me: null, room: null,
    round: null, progress: null, reveal: null, present: null, connStatus: null,
    hostClosed: false, connecting: false, error: null,
  });
};

// Host: warn before closing the tab (it ends the game for everyone).
window.addEventListener("beforeunload", (e) => {
  if (role === "host" && engine && engine.status !== STATUS.LOBBY) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---- start ---------------------------------------------------------------

initUI();
if (!tryResume()) {
  // Prefill join code from a shared link (#123456) but let the user pick a name.
  const hash = location.hash.replace(/[^0-9]/g, "");
  if (hash.length === 6) {
    requestAnimationFrame(() => {
      const codeInput = document.querySelector('input[inputmode="numeric"]');
      if (codeInput) codeInput.value = hash;
    });
  }
}
