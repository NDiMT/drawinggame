// Shared message contract between host (authoritative) and clients.
// The host browser plays the role the spec assigns to the Socket.IO server.

// PeerJS host id = PEER_PREFIX + roomCode. The public broker is a shared
// global namespace, so this prefix is intentionally distinctive to avoid
// colliding with unrelated apps. Code collisions within our own app are
// handled by regenerating the code (CODE_TAKEN).
export const PEER_PREFIX = "doodle-relay-v1-";

// Client -> Host
export const C = {
  JOIN: "join",
  UPDATE_PROFILE: "updateProfile",
  START_GAME: "startGame",
  SUBMIT_TEXT: "submitText",
  SUBMIT_DRAWING: "submitDrawing",
  REACTION: "reaction",
  KICK: "kick",
  PLAY_AGAIN: "playAgain",
  LEAVE: "leave",
};

// Host -> Client
export const S = {
  JOINED: "joined",
  ERROR: "error",
  ROOM_STATE: "roomState",
  ROUND_STARTED: "roundStarted",
  ROUND_PROGRESS: "roundProgress",
  ROUND_ENDED: "roundEnded",
  WAITING: "waiting",
  REVEAL_STARTED: "revealStarted",
  REACTION_NEW: "reactionNew",
  GAME_FINISHED: "gameFinished",
  KICKED: "kicked",
  HOST_CLOSED: "hostClosed",
};

export const TASK = { WRITE: "write", DRAW: "draw", GUESS: "guess" };
export const ENTRY = { PROMPT: "prompt", DRAWING: "drawing", GUESS: "guess" };
export const STATUS = {
  LOBBY: "lobby",
  PLAYING: "playing",
  REVEALING: "revealing",
  FINISHED: "finished",
};

export const MIN_PLAYERS = 3;
export const MAX_TEXT = 120;

export const DEFAULT_SETTINGS = {
  maxPlayers: 10,
  writingTimer: 60,
  drawingTimer: 120,
  guessingTimer: 60,
};

export function taskTypeForRound(round) {
  if (round === 1) return TASK.WRITE;
  return round % 2 === 0 ? TASK.DRAW : TASK.GUESS;
}

export function entryTypeForTask(task) {
  if (task === TASK.WRITE) return ENTRY.PROMPT;
  if (task === TASK.DRAW) return ENTRY.DRAWING;
  return ENTRY.GUESS;
}
