// Αστεία μουσική παρουσίασης — φτιαγμένη με Web Audio (χωρίς αρχείο ήχου).
// Ένα χαζο-χαρούμενο "τσίρκο" loop: staccato μελωδία + oom-pah μπάσο.

let ctx = null;
let master = null;
let enabled = true;       // προτίμηση χρήστη
let running = false;      // παίζει τώρα;
let timer = null;
let stepIdx = 0;
let gestureHooked = false;

// Συχνότητες (Hz). 0 = παύση.
const MELODY = [
  523, 659, 784, 659, 523, 659, 784, 659,   // C E G E ...
  698, 880, 698, 880, 784, 988, 784, 0,     // F A .. G B ..
  523, 659, 784, 659, 523, 659, 784, 659,
  698, 587, 698, 784, 523, 0, 392, 0,
];
const BASS = [131, 0, 98, 0, 131, 0, 98, 0]; // oom-pah ανά 2 βήματα
const STEP_MS = 150;

function ensure() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.06;
  master.connect(ctx.destination);
}

function blip(freq, dur, type, gain) {
  if (!freq) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function tick() {
  if (!running) return;
  blip(MELODY[stepIdx % MELODY.length], 0.13, "square", 0.9);
  if (stepIdx % 2 === 0) blip(BASS[(stepIdx / 2) % BASS.length], 0.18, "triangle", 1.2);
  stepIdx++;
  timer = setTimeout(tick, STEP_MS);
}

// Τα browsers μπλοκάρουν autoplay χωρίς user gesture — ξεκίνα στο πρώτο tap.
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
