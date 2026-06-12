// Tiny dependency-free confetti burst. Draws on a full-screen overlay canvas
// and cleans itself up when the particles settle.

const COLORS = ["#7c3aed", "#ec4899", "#f59e0b", "#22c55e", "#3b82f6", "#ef4444", "#14b8a6"];

export function confetti({ duration = 2600, count = 160 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  };
  resize();
  window.addEventListener("resize", resize);

  const W = () => canvas.width;
  const H = () => canvas.height;
  const parts = Array.from({ length: count }, () => ({
    x: Math.random() * W(),
    y: -Math.random() * H() * 0.3,
    r: (6 + Math.random() * 8) * dpr,
    vx: (Math.random() - 0.5) * 6 * dpr,
    vy: (3 + Math.random() * 5) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: COLORS[(Math.random() * COLORS.length) | 0],
    shape: Math.random() < 0.5 ? "rect" : "circle",
  }));

  const start = performance.now();
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W(), H());
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05 * dpr;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === "rect") ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      else { ctx.beginPath(); ctx.arc(0, 0, p.r / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else {
      window.removeEventListener("resize", resize);
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}
