// All screen rendering. Subscribes to the store and re-renders the active
// screen. Sends player actions through actions.js. Pure view layer — it never
// decides game state, it only reflects what the host sends.

import { store } from "./store.js";
import { actions } from "./actions.js";
import { C, TASK, MIN_PLAYERS, MAX_TEXT } from "./protocol.js";
import { el, AVATAR_COLORS, randomColor } from "./util.js";
import { DrawingCanvas } from "./canvas.js";

const REACTIONS = ["👍", "😂", "😮", "❤️", "🔥", "👏"];
let root;
let activeCanvas = null;
let countdownTimer = null;

export function initUI() {
  root = document.getElementById("app");
  store.subscribe(render);
  render(store.get());
}

function render(s) {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  activeCanvas = null;
  root.innerHTML = "";

  if (s.hostClosed) return root.appendChild(hostClosedScreen());
  if (s.connecting) return root.appendChild(connectingScreen(s));

  switch (s.screen) {
    case "home": return root.appendChild(homeScreen(s));
    case "lobby": return root.appendChild(lobbyScreen(s));
    case "round": return root.appendChild(roundScreen(s));
    case "waiting": return root.appendChild(waitingScreen(s));
    case "reveal": return root.appendChild(revealScreen(s));
    default: return root.appendChild(homeScreen(s));
  }
}

// ---- helpers ------------------------------------------------------------

function avatar(player, size = 36) {
  const initial = (player.nickname || "?").trim().charAt(0).toUpperCase();
  return el("div", {
    class: "avatar",
    style: `background:${player.avatarColor};width:${size}px;height:${size}px;font-size:${size * 0.45}px`,
    title: player.nickname,
  }, initial);
}

function header(title, subtitle) {
  return el("div", { class: "screen-head" }, [
    el("h1", { class: "logo", text: "Doodle Relay" }),
    title ? el("h2", { class: "screen-title", text: title }) : null,
    subtitle ? el("p", { class: "muted", text: subtitle }) : null,
  ]);
}

// ---- HOME ---------------------------------------------------------------

const PROFILE_KEY = "dr_profile";
function loadProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch { return {}; }
}
function saveProfile(p) { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }

function homeScreen(s) {
  const saved = loadProfile();
  let nickname = saved.nickname || "";
  let color = saved.avatarColor || randomColor();

  const nickInput = el("input", {
    class: "input", maxlength: "16", placeholder: "Your nickname", value: nickname,
    oninput: (e) => { nickname = e.target.value; },
  });
  const codeInput = el("input", {
    class: "input", inputmode: "numeric", maxlength: "6", placeholder: "6-digit code",
  });

  const swatches = el("div", { class: "swatches" },
    AVATAR_COLORS.map((c) =>
      el("button", {
        class: "swatch" + (c === color ? " sel" : ""),
        style: `background:${c}`,
        onclick: (e) => {
          color = c;
          e.currentTarget.parentElement.querySelectorAll(".swatch").forEach((x) => x.classList.remove("sel"));
          e.currentTarget.classList.add("sel");
        },
      })
    )
  );

  const create = () => {
    const nn = nickname.trim();
    if (!nn) return flash("Enter a nickname first");
    saveProfile({ nickname: nn, avatarColor: color });
    actions.createRoom({ nickname: nn, avatarColor: color });
  };
  const join = () => {
    const nn = nickname.trim();
    const code = (codeInput.value || "").replace(/\D/g, "");
    if (!nn) return flash("Enter a nickname first");
    if (code.length !== 6) return flash("Enter the 6-digit code");
    saveProfile({ nickname: nn, avatarColor: color });
    actions.joinRoom(code, { nickname: nn, avatarColor: color });
  };

  return el("div", { class: "card home" }, [
    header(null, "Write it. Draw it. Lose it in translation."),
    el("label", { class: "field-label", text: "Nickname" }),
    nickInput,
    el("label", { class: "field-label", text: "Pick a colour" }),
    swatches,
    el("div", { class: "divider" }),
    el("button", { class: "btn primary big", onclick: create }, "Create room"),
    el("div", { class: "or", text: "or join with a code" }),
    el("div", { class: "row" }, [
      codeInput,
      el("button", { class: "btn", onclick: join }, "Join"),
    ]),
    s.error ? el("div", { class: "error-banner", text: s.error }) : null,
    el("p", { class: "tiny muted", text: "Best with 3+ friends on the same Wi-Fi or anywhere online." }),
  ]);
}

// ---- LOBBY --------------------------------------------------------------

function lobbyScreen(s) {
  const room = s.room || { players: [], settings: {} };
  const me = s.me || {};
  const amHost = s.isHost;
  const shareUrl = `${location.origin}${location.pathname}#${s.roomCode}`;

  const playerList = el("div", { class: "player-grid" },
    room.players.map((p) =>
      el("div", { class: "player-chip" + (p.isConnected ? "" : " offline") }, [
        avatar(p, 40),
        el("div", { class: "p-meta" }, [
          el("span", { class: "p-name", text: p.nickname }),
          el("span", { class: "p-tags" }, [
            p.isHost ? el("span", { class: "tag host", text: "HOST" }) : null,
            p.isConnected ? null : el("span", { class: "tag off", text: "offline" }),
          ]),
        ]),
        (amHost && !p.isHost)
          ? el("button", { class: "kick", title: "Kick", onclick: () => actions.sendToHost({ t: C.KICK, targetId: p.id }) }, "✕")
          : null,
      ])
    )
  );

  const settings = room.settings || {};
  const startDisabled = room.players.filter((p) => p.isConnected).length < MIN_PLAYERS;

  return el("div", { class: "card lobby" }, [
    header("Lobby", null),
    el("div", { class: "code-box" }, [
      el("span", { class: "muted tiny", text: "ROOM CODE" }),
      el("div", { class: "code", text: s.roomCode }),
      el("button", { class: "btn small", onclick: () => copy(shareUrl, "Invite link copied!") }, "Copy invite link"),
    ]),
    el("h3", { class: "section", text: `Players (${room.players.length})` }),
    playerList,
    amHost ? hostSettings(settings) : el("p", { class: "muted tiny", text: "Waiting for the host to start…" }),
    amHost
      ? el("button", {
          class: "btn primary big", disabled: startDisabled || false,
          onclick: () => actions.sendToHost({ t: C.START_GAME }),
        }, startDisabled ? `Need ${MIN_PLAYERS}+ players` : "Start game")
      : null,
    el("button", { class: "btn ghost", onclick: () => actions.leaveRoom() }, "Leave"),
    s.error ? el("div", { class: "error-banner", text: s.error }) : null,
  ]);
}

function hostSettings(settings) {
  // Host can tweak timers before start; sent via updateProfile-like message.
  const mk = (label, key, val, min, max) =>
    el("div", { class: "setting" }, [
      el("span", { class: "muted tiny", text: label }),
      el("input", {
        class: "input small", type: "number", min, max, value: val,
        onchange: (e) => actions.sendToHost({ t: "updateSettings", key, value: Number(e.target.value) }),
      }),
    ]);
  return el("details", { class: "settings" }, [
    el("summary", { text: "Round timers (seconds)" }),
    el("div", { class: "settings-grid" }, [
      mk("Writing", "writingTimer", settings.writingTimer ?? 60, 15, 300),
      mk("Drawing", "drawingTimer", settings.drawingTimer ?? 120, 30, 400),
      mk("Guessing", "guessingTimer", settings.guessingTimer ?? 60, 15, 300),
    ]),
  ]);
}

// ---- ROUND --------------------------------------------------------------

function roundScreen(s) {
  const r = s.round;
  if (!r) return waitingScreen(s);
  if (r.taskType === TASK.WRITE) return writingScreen(s);
  if (r.taskType === TASK.DRAW) return drawingScreen(s);
  return guessingScreen(s);
}

function timerBar(deadline) {
  const wrap = el("div", { class: "timer" }, [
    el("div", { class: "timer-fill" }),
    el("span", { class: "timer-text" }),
  ]);
  const fill = wrap.querySelector(".timer-fill");
  const text = wrap.querySelector(".timer-text");
  const total = Math.max(1, (deadline - Date.now()) / 1000);
  const tick = () => {
    const left = Math.max(0, (deadline - Date.now()) / 1000);
    fill.style.width = `${Math.min(100, (left / total) * 100)}%`;
    text.textContent = `${Math.ceil(left)}s`;
    if (left <= 0 && countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  };
  tick();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 250);
  return wrap;
}

function roundBadge(r) {
  const labels = { write: "Round 1 · Write", draw: "Draw it!", guess: "Guess it!" };
  return el("div", { class: "round-badge", text: `Round ${r.roundNumber}/${r.totalRounds} · ${labels[r.taskType] || ""}` });
}

function writingScreen(s) {
  const r = s.round;
  let value = "";
  const ta = el("textarea", {
    class: "input textarea", maxlength: String(MAX_TEXT),
    placeholder: "Write a weird sentence for someone else to draw…",
    oninput: (e) => { value = e.target.value; counter.textContent = `${value.length}/${MAX_TEXT}`; },
  });
  const counter = el("span", { class: "muted tiny", text: `0/${MAX_TEXT}` });
  const submit = () => {
    actions.sendToHost({ t: C.SUBMIT_TEXT, assignmentId: r.assignmentId, text: value });
    store.set({ screen: "waiting", submitted: true });
  };
  return el("div", { class: "card round" }, [
    roundBadge(r),
    timerBar(r.deadline),
    el("p", { class: "prompt-instr", text: "Write something funny and unexpected." }),
    ta, counter,
    el("button", { class: "btn primary big", onclick: submit }, "Submit"),
  ]);
}

function guessingScreen(s) {
  const r = s.round;
  let value = "";
  const counter = el("span", { class: "muted tiny", text: `0/${MAX_TEXT}` });
  const inp = el("input", {
    class: "input", maxlength: String(MAX_TEXT), placeholder: "What is this?",
    oninput: (e) => { value = e.target.value; counter.textContent = `${value.length}/${MAX_TEXT}`; },
  });
  const submit = () => {
    actions.sendToHost({ t: C.SUBMIT_TEXT, assignmentId: r.assignmentId, text: value });
    store.set({ screen: "waiting", submitted: true });
  };
  return el("div", { class: "card round" }, [
    roundBadge(r),
    timerBar(r.deadline),
    el("p", { class: "prompt-instr", text: "What did they draw?" }),
    (r.input && r.input.imageUrl)
      ? el("img", { class: "drawing-view", src: r.input.imageUrl, alt: "drawing to guess" })
      : el("div", { class: "muted", text: "(no drawing)" }),
    inp, counter,
    el("button", { class: "btn primary big", onclick: submit }, "Submit guess"),
  ]);
}

function drawingScreen(s) {
  const r = s.round;
  const canvasEl = el("canvas", { class: "draw-canvas", width: "1024", height: "768" });
  const wrap = el("div", { class: "card round drawing" }, [
    roundBadge(r),
    timerBar(r.deadline),
    el("div", { class: "prompt-chip" }, [
      el("span", { class: "muted tiny", text: "DRAW THIS" }),
      el("span", { class: "prompt-text", text: (r.input && r.input.text) || "(no prompt)" }),
    ]),
    canvasEl,
    toolbar(),
    el("button", { class: "btn primary big", id: "submit-draw" }, "Submit drawing"),
  ]);

  // Defer canvas init until it's in the DOM (needs layout size).
  requestAnimationFrame(() => {
    activeCanvas = new DrawingCanvas(canvasEl, { width: 1024, height: 768 });
    wireToolbar(wrap, activeCanvas);
    wrap.querySelector("#submit-draw").addEventListener("click", () => {
      const png = activeCanvas.toPNG();
      actions.sendToHost({ t: C.SUBMIT_DRAWING, assignmentId: r.assignmentId, imageUrl: png });
      store.set({ screen: "waiting", submitted: true });
    });
  });
  return wrap;
}

function toolbar() {
  const colors = ["#111827", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#ffffff"];
  return el("div", { class: "toolbar" }, [
    el("div", { class: "tool-colors" },
      colors.map((c) => el("button", { class: "tool-color", "data-color": c, style: `background:${c}` }))),
    el("div", { class: "tool-row" }, [
      el("button", { class: "tool-btn", "data-tool": "pen", text: "✏️" }),
      el("button", { class: "tool-btn", "data-tool": "eraser", text: "🧽" }),
      el("input", { class: "size-slider", type: "range", min: "1", max: "40", value: "6", "data-size": "1" }),
      el("button", { class: "tool-btn", "data-act": "undo", text: "↶" }),
      el("button", { class: "tool-btn", "data-act": "redo", text: "↷" }),
      el("button", { class: "tool-btn", "data-act": "clear", text: "🗑" }),
    ]),
  ]);
}

function wireToolbar(wrap, canvas) {
  wrap.querySelectorAll(".tool-color").forEach((b) =>
    b.addEventListener("click", () => {
      canvas.setColor(b.dataset.color);
      wrap.querySelectorAll(".tool-color").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      wrap.querySelectorAll('.tool-btn[data-tool]').forEach((x) => x.classList.remove("sel"));
      wrap.querySelector('[data-tool="pen"]').classList.add("sel");
    }));
  wrap.querySelectorAll(".tool-btn[data-tool]").forEach((b) =>
    b.addEventListener("click", () => {
      canvas.setTool(b.dataset.tool);
      wrap.querySelectorAll(".tool-btn[data-tool]").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
    }));
  wrap.querySelector(".size-slider").addEventListener("input", (e) => canvas.setSize(Number(e.target.value)));
  wrap.querySelector('[data-act="undo"]').addEventListener("click", () => canvas.undo());
  wrap.querySelector('[data-act="redo"]').addEventListener("click", () => canvas.redo());
  wrap.querySelector('[data-act="clear"]').addEventListener("click", () => canvas.clear());
  wrap.querySelector('[data-tool="pen"]').classList.add("sel");
}

// ---- WAITING ------------------------------------------------------------

const WAIT_MSGS = [
  "Masterpieces in progress…",
  "Somebody is definitely overthinking this.",
  "Hold tight, the chaos is loading.",
  "No peeking at your neighbour's screen!",
  "Great art takes (a little) time.",
];

function waitingScreen(s) {
  const prog = s.progress || { submitted: 0, total: (s.room && s.room.players.length) || 0 };
  const pct = prog.total ? Math.round((prog.submitted / prog.total) * 100) : 0;
  const msg = WAIT_MSGS[(prog.submitted + (s.round ? s.round.roundNumber : 0)) % WAIT_MSGS.length];
  return el("div", { class: "card waiting" }, [
    el("div", { class: "spinner" }),
    el("h2", { class: "screen-title", text: "Waiting for everyone…" }),
    el("p", { class: "muted", text: msg }),
    el("div", { class: "progress" }, [el("div", { class: "progress-fill", style: `width:${pct}%` })]),
    el("p", { class: "big-count", text: `${prog.submitted} / ${prog.total} ready` }),
  ]);
}

// ---- REVEAL -------------------------------------------------------------

let revealIndex = 0;

function revealScreen(s) {
  const chains = s.reveal || [];
  if (!chains.length) return el("div", { class: "card" }, [el("p", { text: "Nothing to reveal." })]);
  revealIndex = Math.max(0, Math.min(revealIndex, chains.length - 1));
  const chain = chains[revealIndex];

  const entries = el("div", { class: "reveal-entries" },
    chain.entries.map((e) => revealEntry(chain, e)));

  return el("div", { class: "card reveal" }, [
    header(null, null),
    el("div", { class: "reveal-nav" }, [
      el("button", { class: "btn small", disabled: revealIndex === 0 || false, onclick: () => { revealIndex--; render(store.get()); } }, "‹ Prev"),
      el("span", { class: "muted", text: `Chain ${revealIndex + 1} / ${chains.length}` }),
      el("button", { class: "btn small", disabled: revealIndex === chains.length - 1 || false, onclick: () => { revealIndex++; render(store.get()); } }, "Next ›"),
    ]),
    chain.originPlayer
      ? el("p", { class: "muted tiny", text: `Started by ${chain.originPlayer.nickname}` })
      : null,
    entries,
    el("div", { class: "reveal-actions" }, [
      el("button", { class: "btn", onclick: () => downloadChain(chain) }, "⬇ Download chain"),
      s.isHost
        ? el("button", { class: "btn primary", onclick: () => actions.sendToHost({ t: C.PLAY_AGAIN }) }, "Play again")
        : null,
      el("button", { class: "btn ghost", onclick: () => actions.leaveRoom() }, "Leave"),
    ]),
  ]);
}

function revealEntry(chain, e) {
  const who = e.player ? e.player.nickname : "?";
  const body = e.type === "drawing"
    ? el("img", { class: "reveal-img", src: e.imageUrl, alt: "drawing" })
    : el("div", { class: "reveal-text", text: e.textContent });
  const reactRow = el("div", { class: "react-row" },
    REACTIONS.map((emoji) => {
      const count = (e.reactions && e.reactions[emoji]) || 0;
      return el("button", {
        class: "react-btn",
        onclick: () => actions.sendToHost({ t: C.REACTION, chainId: chain.id, entryId: e.id, emoji }),
      }, [document.createTextNode(emoji), count ? el("span", { class: "react-count", text: String(count) }) : null]);
    }));
  return el("div", { class: "reveal-entry" }, [
    el("div", { class: "reveal-who" }, [
      e.player ? avatar(e.player, 28) : null,
      el("span", { class: "tiny", text: `${who} · ${e.type}` }),
    ]),
    body,
    reactRow,
  ]);
}

// Compose the chain into one tall PNG and download it.
async function downloadChain(chain) {
  const W = 720, pad = 24, gap = 18;
  const blocks = [];
  for (const e of chain.entries) {
    if (e.type === "drawing") {
      const img = await loadImg(e.imageUrl);
      const h = (W - pad * 2) * (img.height / img.width);
      blocks.push({ kind: "img", img, h: h + 26 });
    } else {
      const lines = wrapText(e.textContent || "", 40);
      blocks.push({ kind: "text", text: e.textContent || "", lines, h: 26 + lines.length * 28 + 14 });
    }
  }
  const total = pad * 2 + blocks.reduce((a, b) => a + b.h + gap, 0) + 40;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = total;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fdf6ec"; ctx.fillRect(0, 0, W, total);
  ctx.fillStyle = "#7c3aed"; ctx.font = "bold 26px system-ui, sans-serif";
  ctx.fillText("Doodle Relay", pad, 38);
  let y = 64;
  for (const b of blocks) {
    ctx.fillStyle = "#6b7280"; ctx.font = "13px system-ui, sans-serif";
    if (b.kind === "img") {
      ctx.drawImage(b.img, pad, y, W - pad * 2, b.h - 26);
      y += b.h + gap;
    } else {
      ctx.fillStyle = "#111827"; ctx.font = "20px system-ui, sans-serif";
      b.lines.forEach((ln, i) => ctx.fillText(ln, pad, y + 24 + i * 28));
      y += b.h + gap;
    }
  }
  const a = document.createElement("a");
  a.href = cv.toDataURL("image/png");
  a.download = `doodle-relay-chain-${chain.index + 1}.png`;
  a.click();
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}
function wrapText(text, max) {
  const words = String(text).split(" ");
  const lines = []; let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > max) { lines.push(line.trim()); line = w; }
    else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.length ? lines : [""];
}

// ---- system screens -----------------------------------------------------

function connectingScreen(s) {
  return el("div", { class: "card waiting" }, [
    el("div", { class: "spinner" }),
    el("h2", { class: "screen-title", text: "Connecting…" }),
    el("p", { class: "muted", text: s.roomCode ? `Room ${s.roomCode}` : "Setting up peer connection" }),
  ]);
}

function hostClosedScreen() {
  return el("div", { class: "card waiting" }, [
    el("h2", { class: "screen-title", text: "Host left" }),
    el("p", { class: "muted", text: "The host closed the room. Trying to reconnect…" }),
    el("button", { class: "btn", onclick: () => actions.leaveRoom() }, "Back to home"),
  ]);
}

// ---- toast --------------------------------------------------------------

function flash(text) {
  const t = el("div", { class: "toast", text });
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2200);
}

function copy(text, msg) {
  navigator.clipboard?.writeText(text).then(() => flash(msg)).catch(() => flash(text));
}
