// Όλο το rendering των οθονών. Κάνει subscribe στο store και ξανασχεδιάζει την
// ενεργή οθόνη. Στέλνει ενέργειες παίκτη μέσω actions.js. Καθαρό view layer —
// δεν αποφασίζει ποτέ state, απλώς δείχνει ό,τι στέλνει ο host.

import { store } from "./store.js";
import { actions } from "./actions.js";
import { C, TASK, MIN_PLAYERS, MAX_TEXT } from "./protocol.js";
import { el, AVATAR_COLORS, randomColor } from "./util.js";
import { DrawingCanvas } from "./canvas.js";
import { confetti } from "./confetti.js";

const REACTIONS = ["👍", "😂", "😮", "❤️", "🔥", "👏"];
const LOGO_SRC = "./assets/logo.png";

let root;
let activeCanvas = null;
let countdownTimer = null;

// ---- presentation (cinematic reveal) state ----
let revealMode = "show";        // "show" (auto-play) | "gallery" (περιήγηση)
let revealMounted = false;
let presentSteps = [];
let presentIdx = 0;
let presentPlaying = true;
let presentTimer = null;
let presentChainsRef = null;

export function initUI() {
  root = document.getElementById("app");
  store.subscribe(render);
  render(store.get());
}

function clearCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}
function teardownReveal() {
  if (presentTimer) { clearTimeout(presentTimer); presentTimer = null; }
  presentSteps = [];
  presentChainsRef = null;
  revealMounted = false;
  revealMode = "show";
}

function render(s) {
  if (s.hostClosed) { teardownReveal(); clearCountdown(); activeCanvas = null; root.innerHTML = ""; return root.appendChild(hostClosedScreen()); }
  if (s.connecting) { teardownReveal(); clearCountdown(); activeCanvas = null; root.innerHTML = ""; return root.appendChild(connectingScreen(s)); }

  if (s.screen !== "reveal") teardownReveal();
  // Η αυτόματη παρουσίαση οδηγεί μόνη της το DOM — αγνόησε ασήμαντα store updates
  // (π.χ. reactions) ώστε να μην ξεκινά απ' την αρχή.
  if (s.screen === "reveal" && revealMounted && revealMode === "show") return;

  clearCountdown();
  activeCanvas = null;
  root.innerHTML = "";

  switch (s.screen) {
    case "home": return root.appendChild(homeScreen(s));
    case "lobby": return root.appendChild(lobbyScreen(s));
    case "round": return root.appendChild(roundScreen(s));
    case "waiting": return root.appendChild(waitingScreen(s));
    case "reveal": return mountReveal(s);
    default: return root.appendChild(homeScreen(s));
  }
}

// ---- helpers ------------------------------------------------------------

function logo(cls = "") {
  return el("img", { class: "logo-img " + cls, src: LOGO_SRC, alt: "Tinaftore" });
}

function avatar(player, size = 36) {
  const initial = (player.nickname || "?").trim().charAt(0).toUpperCase();
  return el("div", {
    class: "avatar",
    style: `background:${player.avatarColor};width:${size}px;height:${size}px;font-size:${size * 0.45}px`,
    title: player.nickname,
  }, initial);
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
    class: "input", maxlength: "16", placeholder: "Το ψευδώνυμό σου", value: nickname,
    oninput: (e) => { nickname = e.target.value; },
  });
  const codeInput = el("input", {
    class: "input", inputmode: "numeric", maxlength: "6", placeholder: "6ψήφιος κωδικός",
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
    if (!nn) return flash("Βάλε πρώτα ψευδώνυμο");
    saveProfile({ nickname: nn, avatarColor: color });
    actions.createRoom({ nickname: nn, avatarColor: color });
  };
  const join = () => {
    const nn = nickname.trim();
    const code = (codeInput.value || "").replace(/\D/g, "");
    if (!nn) return flash("Βάλε πρώτα ψευδώνυμο");
    if (code.length !== 6) return flash("Βάλε τον 6ψήφιο κωδικό");
    saveProfile({ nickname: nn, avatarColor: color });
    actions.joinRoom(code, { nickname: nn, avatarColor: color });
  };

  return el("div", { class: "card home" }, [
    el("div", { class: "brand" }, [logo("big"), el("p", { class: "tagline", text: "Γράψε. Ζωγράφισε. Μάντεψε. Γέλα." })]),
    el("label", { class: "field-label", text: "Ψευδώνυμο" }),
    nickInput,
    el("label", { class: "field-label", text: "Διάλεξε χρώμα" }),
    swatches,
    el("div", { class: "divider" }),
    el("button", { class: "btn primary big", onclick: create }, "🎮 Φτιάξε δωμάτιο"),
    el("div", { class: "or", text: "ή μπες με κωδικό" }),
    el("div", { class: "row" }, [
      codeInput,
      el("button", { class: "btn", onclick: join }, "Μπες"),
    ]),
    s.error ? el("div", { class: "error-banner", text: s.error }) : null,
    el("p", { class: "tiny muted center", text: "Ιδανικό για 3+ φίλους — στο ίδιο WiFi ή από παντού." }),
  ]);
}

// ---- LOBBY --------------------------------------------------------------

function lobbyScreen(s) {
  const room = s.room || { players: [], settings: {} };
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
            p.isConnected ? null : el("span", { class: "tag off", text: "εκτός" }),
          ]),
        ]),
        (amHost && !p.isHost)
          ? el("button", { class: "kick", title: "Διώξε", onclick: () => actions.sendToHost({ t: C.KICK, targetId: p.id }) }, "✕")
          : null,
      ])
    )
  );

  const settings = room.settings || {};
  const connected = room.players.filter((p) => p.isConnected).length;
  const startDisabled = connected < MIN_PLAYERS;

  return el("div", { class: "card lobby" }, [
    el("div", { class: "lobby-head" }, [logo("small"), el("h2", { class: "screen-title", text: "Λόμπι" })]),
    el("div", { class: "code-box" }, [
      el("span", { class: "muted tiny", text: "ΚΩΔΙΚΟΣ ΔΩΜΑΤΙΟΥ" }),
      el("div", { class: "code", text: s.roomCode }),
      el("button", { class: "btn small", onclick: () => copy(shareUrl, "Ο σύνδεσμος αντιγράφηκε!") }, "🔗 Αντιγραφή συνδέσμου"),
    ]),
    el("h3", { class: "section", text: `Παίκτες (${room.players.length})` }),
    playerList,
    amHost ? hostSettings(settings) : el("p", { class: "muted tiny center", text: "Περιμένουμε τον host να ξεκινήσει…" }),
    amHost
      ? el("button", {
          class: "btn primary big", disabled: startDisabled || false,
          onclick: () => actions.sendToHost({ t: C.START_GAME }),
        }, startDisabled ? `Χρειάζονται ${MIN_PLAYERS}+ παίκτες` : "🚀 Ξεκίνα το παιχνίδι")
      : null,
    el("button", { class: "btn ghost", onclick: () => actions.leaveRoom() }, "Αποχώρηση"),
    s.error ? el("div", { class: "error-banner", text: s.error }) : null,
  ]);
}

function hostSettings(settings) {
  const mk = (label, key, val, min, max) =>
    el("div", { class: "setting" }, [
      el("span", { class: "muted tiny", text: label }),
      el("input", {
        class: "input small", type: "number", min, max, value: val,
        onchange: (e) => actions.sendToHost({ t: "updateSettings", key, value: Number(e.target.value) }),
      }),
    ]);
  return el("details", { class: "settings" }, [
    el("summary", { text: "⏱️ Χρόνοι γύρων (δευτερόλεπτα)" }),
    el("div", { class: "settings-grid" }, [
      mk("Γράψιμο", "writingTimer", settings.writingTimer ?? 60, 15, 300),
      mk("Ζωγραφική", "drawingTimer", settings.drawingTimer ?? 120, 30, 400),
      mk("Μάντεμα", "guessingTimer", settings.guessingTimer ?? 60, 15, 300),
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
    wrap.classList.toggle("low", left <= 10);
    if (left <= 0 && countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  };
  tick();
  clearCountdown();
  countdownTimer = setInterval(tick, 250);
  return wrap;
}

function roundBadge(r) {
  const labels = { write: "✍️ Γράψε", draw: "🎨 Ζωγράφισε!", guess: "🤔 Μάντεψε!" };
  return el("div", { class: "round-badge", text: `Γύρος ${r.roundNumber}/${r.totalRounds} · ${labels[r.taskType] || ""}` });
}

function writingScreen(s) {
  const r = s.round;
  let value = "";
  const counter = el("span", { class: "muted tiny", text: `0/${MAX_TEXT}` });
  const ta = el("textarea", {
    class: "input textarea", maxlength: String(MAX_TEXT),
    placeholder: "Γράψε μια παράξενη φράση για να τη ζωγραφίσει κάποιος…",
    oninput: (e) => { value = e.target.value; counter.textContent = `${value.length}/${MAX_TEXT}`; },
  });
  const submit = () => {
    actions.sendToHost({ t: C.SUBMIT_TEXT, assignmentId: r.assignmentId, text: value });
    store.set({ screen: "waiting", submitted: true });
  };
  return el("div", { class: "card round" }, [
    roundBadge(r),
    timerBar(r.deadline),
    el("p", { class: "prompt-instr", text: "Γράψε κάτι αστείο κι απρόσμενο." }),
    ta, counter,
    el("button", { class: "btn primary big", onclick: submit }, "Υποβολή"),
  ]);
}

function guessingScreen(s) {
  const r = s.round;
  let value = "";
  const counter = el("span", { class: "muted tiny", text: `0/${MAX_TEXT}` });
  const inp = el("input", {
    class: "input", maxlength: String(MAX_TEXT), placeholder: "Τι είναι αυτό;",
    oninput: (e) => { value = e.target.value; counter.textContent = `${value.length}/${MAX_TEXT}`; },
  });
  const submit = () => {
    actions.sendToHost({ t: C.SUBMIT_TEXT, assignmentId: r.assignmentId, text: value });
    store.set({ screen: "waiting", submitted: true });
  };
  return el("div", { class: "card round" }, [
    roundBadge(r),
    timerBar(r.deadline),
    el("p", { class: "prompt-instr", text: "Τι ζωγράφισαν;" }),
    (r.input && r.input.imageUrl)
      ? el("img", { class: "drawing-view", src: r.input.imageUrl, alt: "ζωγραφιά προς μάντεμα" })
      : el("div", { class: "muted center", text: "(καμία ζωγραφιά)" }),
    inp, counter,
    el("button", { class: "btn primary big", onclick: submit }, "Υπέβαλε μαντεψιά"),
  ]);
}

function drawingScreen(s) {
  const r = s.round;
  const canvasEl = el("canvas", { class: "draw-canvas", width: "1024", height: "768" });
  const wrap = el("div", { class: "card round drawing" }, [
    roundBadge(r),
    timerBar(r.deadline),
    el("div", { class: "prompt-chip" }, [
      el("span", { class: "muted tiny", text: "ΖΩΓΡΑΦΙΣΕ ΑΥΤΟ" }),
      el("span", { class: "prompt-text", text: (r.input && r.input.text) || "(χωρίς φράση)" }),
    ]),
    canvasEl,
    toolbar(),
    el("button", { class: "btn primary big", id: "submit-draw" }, "Υποβολή ζωγραφιάς"),
  ]);

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
      el("input", { class: "size-slider", type: "range", min: "1", max: "40", value: "6" }),
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
  "Γίνονται αριστουργήματα…",
  "Κάποιος σίγουρα το παρασκέφτεται.",
  "Κρατήσου, φορτώνει το χάος.",
  "Μην κρυφοκοιτάς την οθόνη του διπλανού!",
  "Η τέχνη θέλει (λίγο) χρόνο.",
  "Υπομονή… έρχονται γέλια.",
];

function waitingScreen(s) {
  const prog = s.progress || { submitted: 0, total: (s.room && s.room.players.length) || 0 };
  const pct = prog.total ? Math.round((prog.submitted / prog.total) * 100) : 0;
  const msg = WAIT_MSGS[(prog.submitted + (s.round ? s.round.roundNumber : 0)) % WAIT_MSGS.length];
  return el("div", { class: "card waiting" }, [
    el("div", { class: "spinner" }),
    el("h2", { class: "screen-title", text: "Περιμένουμε τους υπόλοιπους…" }),
    el("p", { class: "muted", text: msg }),
    el("div", { class: "progress" }, [el("div", { class: "progress-fill", style: `width:${pct}%` })]),
    el("p", { class: "big-count", text: `${prog.submitted} / ${prog.total} έτοιμοι` }),
  ]);
}

// ===================  REVEAL  =====================================
// Δύο τρόποι: "show" = αυτόματη cinematic παρουσίαση που παίζει μόνη της,
//            "gallery" = ελεύθερη περιήγηση με reactions + κατέβασμα.

function mountReveal(s) {
  if (revealMode === "gallery") {
    revealMounted = true;
    return root.appendChild(galleryScreen(s));
  }
  // show mode
  const chains = s.reveal || [];
  if (!chains.length) {
    return root.appendChild(el("div", { class: "card" }, [el("p", { text: "Δεν υπάρχει τίποτα για αποκάλυψη." })]));
  }
  if (presentChainsRef !== chains || !presentSteps.length) {
    presentChainsRef = chains;
    presentSteps = buildSteps(chains);
    presentIdx = 0;
    presentPlaying = true;
  }
  revealMounted = true;
  showStep();
}

function buildSteps(chains) {
  const steps = [];
  for (const chain of chains) {
    steps.push({ kind: "title", chain });
    chain.entries.forEach((entry, i) => steps.push({ kind: "entry", chain, entry, i }));
  }
  steps.push({ kind: "end" });
  return steps;
}

function stepDuration(step) {
  if (step.kind === "title") return 2100;
  if (step.kind === "end") return 0;
  return step.entry.type === "drawing" ? 4400 : 3400;
}

function showStep() {
  if (presentTimer) { clearTimeout(presentTimer); presentTimer = null; }
  presentIdx = Math.max(0, Math.min(presentIdx, presentSteps.length - 1));
  const step = presentSteps[presentIdx];
  root.innerHTML = "";
  root.appendChild(renderShow(step));
  if (step.kind === "end") {
    confetti();
    return;
  }
  if (presentPlaying) {
    presentTimer = setTimeout(() => { presentIdx++; showStep(); }, stepDuration(step));
  }
}

function presentControls() {
  const totalChains = (presentChainsRef || []).length;
  const cur = presentSteps[presentIdx];
  const chainNo = cur && cur.chain ? cur.chain.index + 1 : totalChains;
  const go = (d) => { presentIdx += d; showStep(); };
  const toGallery = () => { if (presentTimer) clearTimeout(presentTimer); revealMode = "gallery"; revealMounted = false; render(store.get()); };
  const togglePlay = () => { presentPlaying = !presentPlaying; showStep(); };
  return el("div", { class: "show-controls" }, [
    el("button", { class: "ctrl", title: "Προηγούμενο", onclick: () => go(-1) }, "⏮"),
    el("button", { class: "ctrl big-ctrl", title: presentPlaying ? "Παύση" : "Συνέχεια", onclick: togglePlay }, presentPlaying ? "⏸" : "▶"),
    el("button", { class: "ctrl", title: "Επόμενο", onclick: () => go(1) }, "⏭"),
    el("span", { class: "show-count", text: cur && cur.kind !== "end" ? `Αλυσίδα ${chainNo}/${totalChains}` : "" }),
    el("button", { class: "btn small ghost gallery-btn", onclick: toGallery }, "Δες όλες ▦"),
  ]);
}

function renderShow(step) {
  if (step.kind === "end") return renderEnd();

  const totalChains = (presentChainsRef || []).length;

  if (step.kind === "title") {
    const c = step.chain;
    return el("div", { class: "card reveal show" }, [
      el("div", { class: "show-stage title-stage", key: presentIdx }, [
        el("div", { class: "chain-num pop-in", text: `Αλυσίδα ${c.index + 1} / ${totalChains}` }),
        c.originPlayer ? el("div", { class: "title-author pop-in delay1" }, [
          avatar(c.originPlayer, 64),
          el("p", { class: "muted", text: "ξεκίνησε από" }),
          el("h2", { class: "author-name", text: c.originPlayer.nickname }),
        ]) : null,
      ]),
      presentControls(),
    ]);
  }

  // entry step
  const e = step.entry;
  const who = e.player ? e.player.nickname : "?";
  const verb = e.type === "prompt" ? "έγραψε" : e.type === "drawing" ? "ζωγράφισε" : "μάντεψε";
  const lead = e.i === 0 ? "Όλα ξεκίνησαν με…" : null;

  const body = e.type === "drawing"
    ? el("div", { class: "show-drawing-frame pop-in" }, [el("img", { class: "show-drawing", src: e.imageUrl, alt: "ζωγραφιά" })])
    : el("div", { class: "show-bubble pop-in", text: e.textContent });

  return el("div", { class: "card reveal show" }, [
    el("div", { class: "show-stage", key: presentIdx }, [
      lead ? el("p", { class: "show-lead fade-in", text: lead }) : null,
      el("div", { class: "show-author slide-in" }, [
        e.player ? avatar(e.player, 40) : null,
        el("span", { class: "show-name", text: who }),
        el("span", { class: "verb-chip", text: verb }),
      ]),
      body,
    ]),
    presentControls(),
  ]);
}

function renderEnd() {
  const isHost = store.get().isHost;
  return el("div", { class: "card reveal end-card" }, [
    logo("small"),
    el("div", { class: "end-emoji bounce", text: "🎉" }),
    el("h2", { class: "screen-title", text: "Τέλος!" }),
    el("p", { class: "muted", text: "Ελπίζουμε να γελάσατε με την ψυχή σας." }),
    el("div", { class: "reveal-actions" }, [
      el("button", { class: "btn primary", onclick: () => { revealMode = "gallery"; revealMounted = false; render(store.get()); } }, "▦ Δες όλες τις αλυσίδες"),
      el("button", { class: "btn", onclick: () => { presentIdx = 0; showStep(); } }, "🔁 Ξαναπαίξε την παρουσίαση"),
      isHost
        ? el("button", { class: "btn primary", onclick: () => actions.sendToHost({ t: C.PLAY_AGAIN }) }, "🎮 Νέο παιχνίδι")
        : null,
      el("button", { class: "btn ghost", onclick: () => actions.leaveRoom() }, "Αποχώρηση"),
    ]),
  ]);
}

// ---- gallery (manual browse) -------------------------------------------

let galleryIndex = 0;

function galleryScreen(s) {
  const chains = s.reveal || [];
  if (!chains.length) return el("div", { class: "card" }, [el("p", { text: "Δεν υπάρχει τίποτα." })]);
  galleryIndex = Math.max(0, Math.min(galleryIndex, chains.length - 1));
  const chain = chains[galleryIndex];

  const entries = el("div", { class: "reveal-entries" },
    chain.entries.map((e) => galleryEntry(chain, e)));

  return el("div", { class: "card reveal" }, [
    el("div", { class: "lobby-head" }, [logo("small")]),
    el("div", { class: "reveal-nav" }, [
      el("button", { class: "btn small", disabled: galleryIndex === 0 || false, onclick: () => { galleryIndex--; render(store.get()); } }, "‹ Προηγ."),
      el("span", { class: "muted", text: `Αλυσίδα ${galleryIndex + 1} / ${chains.length}` }),
      el("button", { class: "btn small", disabled: galleryIndex === chains.length - 1 || false, onclick: () => { galleryIndex++; render(store.get()); } }, "Επόμ. ›"),
    ]),
    chain.originPlayer
      ? el("p", { class: "muted tiny center", text: `Ξεκίνησε από ${chain.originPlayer.nickname}` })
      : null,
    entries,
    el("div", { class: "reveal-actions" }, [
      el("button", { class: "btn", onclick: () => downloadChain(chain) }, "⬇ Κατέβασε"),
      el("button", { class: "btn", onclick: () => { revealMode = "show"; revealMounted = false; presentIdx = 0; render(store.get()); } }, "▶ Παρουσίαση"),
      s.isHost
        ? el("button", { class: "btn primary", onclick: () => actions.sendToHost({ t: C.PLAY_AGAIN }) }, "🎮 Νέο παιχνίδι")
        : null,
      el("button", { class: "btn ghost", onclick: () => actions.leaveRoom() }, "Αποχώρηση"),
    ]),
  ]);
}

function galleryEntry(chain, e) {
  const who = e.player ? e.player.nickname : "?";
  const verb = e.type === "prompt" ? "έγραψε" : e.type === "drawing" ? "ζωγράφισε" : "μάντεψε";
  const body = e.type === "drawing"
    ? el("img", { class: "reveal-img", src: e.imageUrl, alt: "ζωγραφιά" })
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
      el("span", { class: "tiny", text: `${who} · ${verb}` }),
    ]),
    body,
    reactRow,
  ]);
}

// Συνθέτει την αλυσίδα σε μία εικόνα PNG και την κατεβάζει.
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
      blocks.push({ kind: "text", lines, h: 26 + lines.length * 28 + 14 });
    }
  }
  const total = pad * 2 + blocks.reduce((a, b) => a + b.h + gap, 0) + 40;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = total;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fdf6ec"; ctx.fillRect(0, 0, W, total);
  ctx.fillStyle = "#7c3aed"; ctx.font = "bold 26px system-ui, sans-serif";
  ctx.fillText("Tinaftore", pad, 40);
  let y = 64;
  for (const b of blocks) {
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
  a.download = `tinaftore-alysida-${chain.index + 1}.png`;
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
    logo("small"),
    el("div", { class: "spinner" }),
    el("h2", { class: "screen-title", text: "Σύνδεση…" }),
    el("p", { class: "muted", text: s.roomCode ? `Δωμάτιο ${s.roomCode}` : "Στήνουμε τη σύνδεση peer-to-peer" }),
  ]);
}

function hostClosedScreen() {
  return el("div", { class: "card waiting" }, [
    el("h2", { class: "screen-title", text: "Ο host αποχώρησε" }),
    el("p", { class: "muted", text: "Έκλεισε το δωμάτιο. Προσπαθούμε επανασύνδεση…" }),
    el("button", { class: "btn", onclick: () => actions.leaveRoom() }, "Πίσω στην αρχή"),
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
