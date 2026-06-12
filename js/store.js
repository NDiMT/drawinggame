// Lightweight reactive store for the local client view. UI subscribes and
// re-renders on change. The host runs the engine in the same tab but its UI
// consumes server messages through exactly this store, so both roles share
// one rendering path.

const state = {
  screen: "home",          // home | lobby | round | waiting | reveal
  isHost: false,
  roomCode: null,
  me: null,                // { id, nickname, avatarColor, ... }
  room: null,              // full room state from host
  round: null,             // current round task payload
  progress: null,          // { submitted, total }
  submitted: false,        // have I submitted this round
  reveal: null,            // chains for reveal
  present: null,           // { index, playing } — host-driven presentation cursor
  connStatus: null,        // connecting | connected | reconnecting | offline | host
  error: null,
  connecting: false,
  hostClosed: false,
};

const subs = new Set();

export const store = {
  get: () => state,
  set(patch) {
    Object.assign(state, patch);
    subs.forEach((fn) => fn(state));
  },
  subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};
