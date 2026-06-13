// Authoritative game engine. Runs only on the host browser.
// Transport is injected so the engine never touches WebRTC directly:
//   transport.send(playerId, msg) / transport.broadcast(msg)
// This mirrors the spec's "backend is authoritative; frontend never changes
// state on its own" rule.

import {
  C, S, TASK, STATUS, MIN_PLAYERS, DEFAULT_SETTINGS,
  taskTypeForRound, entryTypeForTask,
} from "./protocol.js?v=14";
import { uid, sanitizeText, randomColor } from "./util.js?v=14";

export class GameEngine {
  constructor({ roomCode, transport, settings = {}, onSnapshot = () => {} }) {
    this.roomCode = roomCode;
    this.transport = transport;
    this.onSnapshot = onSnapshot;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };

    this.status = STATUS.LOBBY;
    this.players = []; // ordered; frozen at game start
    this.hostPlayerId = null;
    this.currentRound = 0;
    this.totalRounds = 0;
    this.chains = [];
    this.assignments = []; // assignments for the current round
    this.deadline = null;
    this.timer = null;
  }

  // ---- player lifecycle -------------------------------------------------

  handleClientMessage(connId, msg) {
    if (!msg || typeof msg.t !== "string") return;
    switch (msg.t) {
      case C.JOIN: return this._onJoin(connId, msg);
      case C.UPDATE_PROFILE: return this._onUpdateProfile(connId, msg);
      case "updateSettings": return this._onUpdateSettings(connId, msg);
      case C.START_GAME: return this._onStartGame(connId);
      case C.SUBMIT_TEXT: return this._onSubmitText(connId, msg);
      case C.SUBMIT_DRAWING: return this._onSubmitDrawing(connId, msg);
      case C.REACTION: return this._onReaction(connId, msg);
      case C.KICK: return this._onKick(connId, msg);
      case C.PRESENT_CONTROL: return this._onPresentControl(connId, msg);
      case C.PLAY_AGAIN: return this._onPlayAgain(connId);
      case C.LEAVE: return this._onLeave(connId);
    }
  }

  _player(connId) {
    return this.players.find((p) => p.connId === connId) || null;
  }

  _onJoin(connId, { nickname, avatarColor, sessionToken, isHost }) {
    const nick = sanitizeText(nickname) || "Player";
    const color = avatarColor || randomColor();

    // Reconnect path: known sessionToken -> restore the same player.
    let player = sessionToken
      ? this.players.find((p) => p.sessionToken === sessionToken)
      : null;

    if (player) {
      player.connId = connId;
      player.isConnected = true;
    } else {
      if (this.status !== STATUS.LOBBY) {
        return this.transport.send(connId, { t: S.ERROR, message: "Game already in progress." });
      }
      if (this.players.length >= this.settings.maxPlayers) {
        return this.transport.send(connId, { t: S.ERROR, message: "Room is full." });
      }
      player = {
        id: uid("p"),
        connId,
        nickname: nick,
        avatarColor: color,
        sessionToken: sessionToken || uid("st"),
        isHost: !!isHost && this.players.length === 0,
        isConnected: true,
      };
      if (player.isHost) this.hostPlayerId = player.id;
      this.players.push(player);
    }

    this._broadcastRoomState();
    this.resyncPlayer(player.id);
    this._save();
  }

  // Send a (re)connecting player everything they need to render the current
  // state: identity, room state, and their active task or the reveal.
  resyncPlayer(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || player.connId == null) return;
    this.transport.send(player.connId, {
      t: S.JOINED,
      you: this._publicPlayer(player),
      sessionToken: player.sessionToken,
    });
    this.transport.send(player.connId, { t: S.ROOM_STATE, room: this._roomState() });
    if (this.status === STATUS.PLAYING) this._sendAssignment(player);
    if (this.status === STATUS.REVEALING || this.status === STATUS.FINISHED) {
      this.transport.send(player.connId, { t: S.REVEAL_STARTED, chains: this._revealData() });
      if (this._present) {
        this.transport.send(player.connId, {
          t: S.PRESENT_STEP, index: this._present.index, playing: this._present.playing,
        });
      }
    }
  }

  _onUpdateProfile(connId, { nickname, avatarColor }) {
    const p = this._player(connId);
    if (!p || this.status !== STATUS.LOBBY) return;
    if (nickname !== undefined) p.nickname = sanitizeText(nickname) || p.nickname;
    if (avatarColor !== undefined) p.avatarColor = avatarColor;
    this._broadcastRoomState();
    this._save();
  }

  _onUpdateSettings(connId, { key, value }) {
    const p = this._player(connId);
    if (!p || !p.isHost || this.status !== STATUS.LOBBY) return;
    const limits = {
      maxPlayers: [3, 16], writingTimer: [15, 300],
      drawingTimer: [30, 400], guessingTimer: [15, 300],
    };
    if (!limits[key] || typeof value !== "number" || Number.isNaN(value)) return;
    const [min, max] = limits[key];
    this.settings[key] = Math.max(min, Math.min(max, Math.round(value)));
    this._broadcastRoomState();
    this._save();
  }

  markDisconnected(connId) {
    const p = this._player(connId);
    if (!p) return;
    p.isConnected = false;
    if (this.status === STATUS.LOBBY) {
      // Drop fully from lobby; reassign host if needed.
      this.players = this.players.filter((x) => x.connId !== connId);
      if (p.isHost) this._reassignHost();
    }
    this._broadcastRoomState();
    this._save();
  }

  _onLeave(connId) {
    const p = this._player(connId);
    if (!p) return;
    if (this.status === STATUS.LOBBY) {
      this.players = this.players.filter((x) => x.connId !== connId);
      if (p.isHost) this._reassignHost();
    } else {
      p.isConnected = false;
    }
    this._broadcastRoomState();
    this._save();
  }

  _reassignHost() {
    if (this.players.length === 0) return;
    const next = this.players.find((p) => p.isConnected) || this.players[0];
    this.players.forEach((p) => (p.isHost = p.id === next.id));
    this.hostPlayerId = next.id;
  }

  _onKick(connId, { targetId }) {
    const host = this._player(connId);
    if (!host || !host.isHost || this.status !== STATUS.LOBBY) return;
    const target = this.players.find((p) => p.id === targetId);
    if (!target || target.isHost) return;
    this.transport.send(target.connId, { t: S.KICKED });
    this.players = this.players.filter((p) => p.id !== targetId);
    this._broadcastRoomState();
    this._save();
  }

  // ---- game start & rounds ---------------------------------------------

  _onStartGame(connId) {
    const p = this._player(connId);
    if (!p || !p.isHost) return;
    if (this.status !== STATUS.LOBBY) return;
    const connected = this.players.filter((x) => x.isConnected);
    if (connected.length < MIN_PLAYERS) {
      return this.transport.send(connId, {
        t: S.ERROR, message: `Need at least ${MIN_PLAYERS} players to start.`,
      });
    }

    // Freeze the ordered player list and build one chain per player.
    this.players = connected;
    this.status = STATUS.PLAYING;
    this.totalRounds = this.players.length;
    this.chains = this.players.map((p, i) => ({
      id: uid("chain"),
      originPlayerId: p.id,
      index: i,
      entries: [],
    }));

    this.transport.broadcast({ t: S.ROOM_STATE, room: this._roomState() });
    this._prepareRound(1);
    this._save();
  }

  _prepareRound(round) {
    this.currentRound = round;
    const task = taskTypeForRound(round);
    const n = this.players.length;

    this.assignments = this.players.map((player, i) => {
      const chainIndex = (i - (round - 1) + n * round) % n;
      const chain = this.chains.find((c) => c.index === chainIndex);
      const inputEntry = round > 1
        ? chain.entries.find((e) => e.roundNumber === round - 1) || null
        : null;
      return {
        id: uid("asg"),
        roundNumber: round,
        playerId: player.id,
        chainId: chain.id,
        inputEntryId: inputEntry ? inputEntry.id : null,
        taskType: task,
        status: "pending",
        submittedEntryId: null,
      };
    });

    const timeLimit = this._timerFor(task);
    this.deadline = Date.now() + timeLimit * 1000;

    for (const player of this.players) this._sendAssignment(player);
    this._broadcastProgress();

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._timeoutRound(), timeLimit * 1000);
  }

  _timerFor(task) {
    if (task === TASK.WRITE) return this.settings.writingTimer;
    if (task === TASK.DRAW) return this.settings.drawingTimer;
    return this.settings.guessingTimer;
  }

  _sendAssignment(player) {
    const asg = this.assignments.find((a) => a.playerId === player.id);
    if (!asg) return;
    let input = null;
    if (asg.inputEntryId) {
      const chain = this.chains.find((c) => c.id === asg.chainId);
      const entry = chain.entries.find((e) => e.id === asg.inputEntryId);
      if (entry) {
        input = entry.type === "drawing"
          ? { type: "drawing", imageUrl: entry.imageUrl }
          : { type: entry.type, text: entry.textContent };
      }
    }
    if (player.connId == null) return;
    this.transport.send(player.connId, {
      t: S.ROUND_STARTED,
      roundNumber: this.currentRound,
      totalRounds: this.totalRounds,
      taskType: asg.taskType,
      timeLimit: this._timerFor(asg.taskType),
      deadline: this.deadline,
      assignmentId: asg.id,
      alreadySubmitted: asg.status !== "pending",
      input,
    });
  }

  _onSubmitText(connId, { assignmentId, text }) {
    const p = this._player(connId);
    if (!p) return;
    const asg = this._validateSubmit(p, assignmentId, [TASK.WRITE, TASK.GUESS]);
    if (!asg) return;
    const clean = sanitizeText(text);
    this._commitEntry(asg, {
      type: entryTypeForTask(asg.taskType),
      textContent: clean.length ? clean : "(no answer)",
      imageUrl: null,
    });
  }

  _onSubmitDrawing(connId, { assignmentId, imageUrl }) {
    const p = this._player(connId);
    if (!p) return;
    const asg = this._validateSubmit(p, assignmentId, [TASK.DRAW]);
    if (!asg) return;
    if (typeof imageUrl !== "string" || !imageUrl.startsWith("data:image/")) {
      return this.transport.send(connId, { t: S.ERROR, message: "Invalid drawing." });
    }
    this._commitEntry(asg, { type: "drawing", textContent: null, imageUrl });
  }

  _validateSubmit(player, assignmentId, allowedTasks) {
    if (this.status !== STATUS.PLAYING) return null;
    const asg = this.assignments.find((a) => a.id === assignmentId);
    if (!asg) return null;
    if (asg.playerId !== player.id) return null;          // assignment ownership
    if (!allowedTasks.includes(asg.taskType)) return null; // correct task type
    if (asg.status !== "pending") return null;             // no double submit
    return asg;
  }

  _commitEntry(asg, { type, textContent, imageUrl }) {
    const chain = this.chains.find((c) => c.id === asg.chainId);
    const entry = {
      id: uid("e"),
      chainId: chain.id,
      roundNumber: asg.roundNumber,
      playerId: asg.playerId,
      type,
      textContent,
      imageUrl,
      reactions: {},
    };
    chain.entries.push(entry);
    asg.status = "submitted";
    asg.submittedEntryId = entry.id;
    this._broadcastProgress();
    if (this.assignments.every((a) => a.status !== "pending")) {
      this._completeRound();
    }
    this._save();
  }

  _timeoutRound() {
    for (const asg of this.assignments) {
      if (asg.status !== "pending") continue;
      const chain = this.chains.find((c) => c.id === asg.chainId);
      const isDraw = asg.taskType === TASK.DRAW;
      const entry = {
        id: uid("e"),
        chainId: chain.id,
        roundNumber: asg.roundNumber,
        playerId: asg.playerId,
        type: entryTypeForTask(asg.taskType),
        textContent: isDraw ? null : "(no answer)",
        imageUrl: isDraw ? BLANK_PNG : null,
        reactions: {},
      };
      chain.entries.push(entry);
      asg.status = "timeout";
      asg.submittedEntryId = entry.id;
    }
    this._completeRound();
  }

  _completeRound() {
    clearTimeout(this.timer);
    this.timer = null;
    this.transport.broadcast({ t: S.ROUND_ENDED, roundNumber: this.currentRound });
    if (this.currentRound < this.totalRounds) {
      // brief pause so clients show a "round complete" beat
      setTimeout(() => this._prepareRound(this.currentRound + 1), 1200);
    } else {
      this._startReveal();
    }
    this._save();
  }

  _startReveal() {
    this.status = STATUS.REVEALING;
    this.transport.broadcast({ t: S.REVEAL_STARTED, chains: this._revealData() });
    this.status = STATUS.FINISHED;
    // The host drives a synchronised, auto-playing presentation: it owns the
    // step cursor + timer and broadcasts the current step to every client.
    this._present = { steps: this._buildPresentSteps(), index: 0, playing: true };
    this._broadcastPresent();
    this._schedulePresent();
    this._save();
  }

  // Flat list of presentation steps (must match the client's buildSteps order):
  // per chain -> title, then one step per entry; finally a single "end" step.
  _buildPresentSteps() {
    const chains = this.chains.slice().sort((a, b) => a.index - b.index);
    const steps = [];
    for (const c of chains) {
      steps.push({ dur: 2100 });
      c.entries.slice().sort((a, b) => a.roundNumber - b.roundNumber)
        .forEach((e) => steps.push({ dur: e.type === "drawing" ? 4400 : 3400 }));
    }
    steps.push({ dur: 0 }); // end
    return steps;
  }

  _schedulePresent() {
    clearTimeout(this._presentTimer);
    const s = this._present;
    if (!s) return;
    const last = s.steps.length - 1;
    if (s.playing && s.index < last) {
      this._presentTimer = setTimeout(() => {
        s.index += 1;
        this._broadcastPresent();
        this._schedulePresent();
      }, s.steps[s.index].dur);
    }
  }

  _broadcastPresent() {
    if (!this._present) return;
    this.transport.broadcast({
      t: S.PRESENT_STEP, index: this._present.index, playing: this._present.playing,
    });
  }

  _onPresentControl(connId, { action }) {
    const p = this._player(connId);
    if (!p || !p.isHost || !this._present) return;
    const s = this._present;
    const last = s.steps.length - 1;
    if (action === "play") s.playing = true;
    else if (action === "pause") s.playing = false;
    else if (action === "next") s.index = Math.min(last, s.index + 1);
    else if (action === "prev") s.index = Math.max(0, s.index - 1);
    else if (action === "restart") { s.index = 0; s.playing = true; }
    else return;
    this._broadcastPresent();
    this._schedulePresent();
  }

  _onReaction(connId, { chainId, entryId, emoji }) {
    if (!["", "👍", "😂", "😮", "❤️", "🔥", "👏"].includes(emoji)) {
      if (typeof emoji !== "string" || emoji.length > 4) return;
    }
    const chain = this.chains.find((c) => c.id === chainId);
    if (!chain) return;
    const entry = chain.entries.find((e) => e.id === entryId);
    if (!entry) return;
    entry.reactions[emoji] = (entry.reactions[emoji] || 0) + 1;
    this.transport.broadcast({ t: S.REACTION_NEW, chainId, entryId, emoji, count: entry.reactions[emoji] });
  }

  _onPlayAgain(connId) {
    const p = this._player(connId);
    if (!p || !p.isHost) return;
    this.status = STATUS.LOBBY;
    this.currentRound = 0;
    this.totalRounds = 0;
    this.chains = [];
    this.assignments = [];
    clearTimeout(this.timer);
    clearTimeout(this._presentTimer);
    this._present = null;
    this.players.forEach((pl) => (pl.isHost = pl.id === this.hostPlayerId));
    this._broadcastRoomState();
    this._save();
  }

  // ---- serialisation ----------------------------------------------------

  _publicPlayer(p) {
    return {
      id: p.id, nickname: p.nickname, avatarColor: p.avatarColor,
      isHost: p.isHost, isConnected: p.isConnected,
    };
  }

  _roomState() {
    return {
      roomCode: this.roomCode,
      status: this.status,
      hostPlayerId: this.hostPlayerId,
      currentRound: this.currentRound,
      totalRounds: this.totalRounds,
      settings: this.settings,
      players: this.players.map((p) => this._publicPlayer(p)),
    };
  }

  _broadcastRoomState() {
    this.transport.broadcast({ t: S.ROOM_STATE, room: this._roomState() });
  }

  _broadcastProgress() {
    const submitted = this.assignments.filter((a) => a.status !== "pending").length;
    this.transport.broadcast({
      t: S.ROUND_PROGRESS,
      roundNumber: this.currentRound,
      submitted,
      total: this.assignments.length,
    });
  }

  _revealData() {
    const byId = Object.fromEntries(this.players.map((p) => [p.id, p]));
    return this.chains
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((chain) => ({
        id: chain.id,
        index: chain.index,
        originPlayer: byId[chain.originPlayerId]
          ? this._publicPlayer(byId[chain.originPlayerId]) : null,
        entries: chain.entries
          .slice()
          .sort((a, b) => a.roundNumber - b.roundNumber)
          .map((e) => ({
            id: e.id,
            roundNumber: e.roundNumber,
            type: e.type,
            textContent: e.textContent,
            imageUrl: e.imageUrl,
            reactions: e.reactions,
            player: byId[e.playerId] ? this._publicPlayer(byId[e.playerId]) : null,
          })),
      }));
  }

  // Persist a recovery snapshot so a host page-refresh can resume the game.
  _save() {
    this.onSnapshot(this._snapshot());
  }

  _snapshot() {
    return {
      roomCode: this.roomCode,
      settings: this.settings,
      status: this.status,
      players: this.players.map((p) => ({ ...p, connId: null, isConnected: false })),
      hostPlayerId: this.hostPlayerId,
      currentRound: this.currentRound,
      totalRounds: this.totalRounds,
      chains: this.chains,
      assignments: this.assignments,
      deadline: this.deadline,
      savedAt: Date.now(),
    };
  }

  restore(snap) {
    this.settings = snap.settings;
    this.status = snap.status;
    this.players = snap.players;
    this.hostPlayerId = snap.hostPlayerId;
    this.currentRound = snap.currentRound;
    this.totalRounds = snap.totalRounds;
    this.chains = snap.chains;
    this.assignments = snap.assignments;
    this.deadline = snap.deadline;
    // Resume an in-flight round timer from where it left off.
    if (this.status === STATUS.PLAYING && this.deadline) {
      const remaining = Math.max(0, this.deadline - Date.now());
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._timeoutRound(), remaining);
    }
    // Resume the presentation from the start if we recovered during reveal.
    if ((this.status === STATUS.REVEALING || this.status === STATUS.FINISHED) && this.chains.length) {
      this._present = { steps: this._buildPresentSteps(), index: 0, playing: true };
      this._schedulePresent();
    }
  }
}

// 1x1 transparent PNG used as the fallback for a timed-out drawing.
const BLANK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
