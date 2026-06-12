// Indirection so the UI can trigger network actions without importing main.js
// (avoids a circular dependency). main.js fills these in at startup.
export const actions = {
  createRoom: (_profile) => {},
  joinRoom: (_code, _profile) => {},
  sendToHost: (_msg) => {},
  leaveRoom: () => {},
};
