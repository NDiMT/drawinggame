// Γελοία μουσική παρουσίασης — φτιαγμένη με Web Audio (χωρίς αρχείο ήχου).
// Καρτουνίστικο "κλόουν" loop: τσαχπίνικη μελωδία + oom-pah μπάσο, με
// "boing" γλιστρήματα και ένα κορναρισμα για το γέλιο.

let ctx = null;
let master = null;
let enabled = true;
let running = false;
let timer = null;
let stepIdx = 0;
let gestureHooked = false;

const STEP_MS = 138;

// Κάθε βήμα: αριθμός = συχνότητα (Hz), 0 = παύση,
// {boing:[από,προς]} = γλίστρημα, {honk:1} = κόρνα.
const SEQ = [
  392, 0, 440, 0, 523, 0, 440, 0,
  587, 0, 523, 0, 659, { boing: [680, 150] }, 0, { honk: 1 },
  392, 0, 440, 523, 0, 659, 0, { boing: [700, 130] },
  330, 392, 466, 523, 622, 0, { honk: 1 }, 0,
];
const BASS = [131, 0, 98, 0, 147, 0, 110, 0]; // oom-pah ανά 2 βήματα

function ensure() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.07;
  master.connect(ctx.destination);
}

function blip(freq, dur, type, gain, detune = 0) {
  if (!freq) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function boing([from, to]) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sawtooth";
  const t = ctx.currentTime;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + 0.28);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(1, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + 0.34);
}

function honk() {
  blip(330, 0.1, "square", 1.1);
  setTimeout(() => running && blip(247, 0.16, "square", 1.1), 90);
}

function tick() {
  if (!running) return;
  const note = SEQ[stepIdx % SEQ.length];
  if (note && typeof note === "object") {
    if (note.boing) boing(note.boing);
    else if (note.honk) honk();
  } else if (note) {
    // ελαφρύ "wobble" detune για κωμική αίσθηση
    blip(note, 0.12, "square", 0.85, (stepIdx % 2 ? 12 : -12));
  }
  if (stepIdx % 2 === 0) blip(BASS[(stepIdx / 2) % BASS.length], 0.17, "triangle", 1.1);
  stepIdx++;
  timer = setTimeout(tick, STEP_MS);
}

function hookGesture() {
  if (gestureHooked) return;
  gestureHooked = true;
  const resume = () => {
    if (ctx && ctx.state === "suspended") ctx.resume();
    window.removeEventListener("pointerdown", resume);
    gestureHooked = false;
  };
  window.addEventListener("pointerdown", resume, { once: true });
}

export function start() {
  if (!enabled) return;
  ensure();
  if (!ctx) return;
  if (ctx.state === "suspended") { ctx.resume(); hookGesture(); }
  if (running) return;
  running = true;
  stepIdx = 0;
  tick();
}

export function stop() {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

export function toggle() {
  enabled = !enabled;
  if (enabled) start();
  else stop();
  return enabled;
}

export function isEnabled() { return enabled; }
