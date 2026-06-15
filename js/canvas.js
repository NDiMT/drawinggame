// Pointer-based drawing canvas with undo/redo, sharp on HiDPI screens,
// touch-friendly. Stores strokes so undo/redo and re-render are exact, and
// exports a PNG data URL for submission.

import { clamp } from "./util.js?v=15";

export class DrawingCanvas {
  constructor(canvas, { width = 1024, height = 768 } = {}) {
    this.canvas = canvas;
    this.logicalW = width;
    this.logicalH = height;
    this.ctx = canvas.getContext("2d");
    this.strokes = [];
    this.redoStack = [];
    this.current = null;

    this.tool = "pen";
    this.color = "#111827";
    this.size = 6;

    this._setupSize();
    this._bind();
    this.redraw();
    window.addEventListener("resize", () => this._setupSize());
  }

  _setupSize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width || this.logicalW;
    const cssH = cssW * (this.logicalH / this.logicalW);
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this._scaleX = this.canvas.width / this.logicalW;
    this._scaleY = this.canvas.height / this.logicalH;
    this.redraw();
  }

  _pos(ev) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * this.logicalW,
      y: ((ev.clientY - rect.top) / rect.height) * this.logicalH,
    };
  }

  _bind() {
    const start = (ev) => {
      ev.preventDefault();
      this.canvas.setPointerCapture(ev.pointerId);
      this.current = {
        tool: this.tool,
        color: this.color,
        size: this.size,
        points: [this._pos(ev)],
      };
    };
    const move = (ev) => {
      if (!this.current) return;
      ev.preventDefault();
      this.current.points.push(this._pos(ev));
      this.redraw();
    };
    const end = (ev) => {
      if (!this.current) return;
      ev.preventDefault();
      if (this.current.points.length === 1) {
        // a tap = a dot
        const p = this.current.points[0];
        this.current.points.push({ x: p.x + 0.1, y: p.y + 0.1 });
      }
      this.strokes.push(this.current);
      this.redoStack = [];
      this.current = null;
      this.redraw();
    };
    this.canvas.addEventListener("pointerdown", start);
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    this.canvas.addEventListener("pointerleave", end);
  }

  _drawStroke(s) {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this._scaleX, this._scaleY);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = s.size;
    if (s.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = s.color;
    }
    const pts = s.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const mid = { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
      ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, mid.x, mid.y);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
    ctx.restore();
  }

  redraw() {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    for (const s of this.strokes) this._drawStroke(s);
    if (this.current) this._drawStroke(this.current);
  }

  setTool(t) { this.tool = t; }
  setColor(c) { this.color = c; this.tool = "pen"; }
  setSize(s) { this.size = clamp(s, 1, 60); }

  undo() {
    if (this.strokes.length) {
      this.redoStack.push(this.strokes.pop());
      this.redraw();
    }
  }
  redo() {
    if (this.redoStack.length) {
      this.strokes.push(this.redoStack.pop());
      this.redraw();
    }
  }
  clear() {
    this.strokes = [];
    this.redoStack = [];
    this.current = null;
    this.redraw();
  }

  isBlank() { return this.strokes.length === 0; }

  // Export a downscaled PNG (white background) to keep data-channel
  // messages small. Strokes are stored in logical coordinates, so we just
  // render them onto an output canvas scaled from logical -> output.
  toPNG(maxW = 900) {
    const scale = Math.min(1, maxW / this.logicalW);
    const out = document.createElement("canvas");
    out.width = Math.round(this.logicalW * scale);
    out.height = Math.round(this.logicalH * scale);
    const octx = out.getContext("2d");
    octx.fillStyle = "#ffffff";
    octx.fillRect(0, 0, out.width, out.height);
    octx.scale(out.width / this.logicalW, out.height / this.logicalH);
    octx.lineJoin = "round";
    octx.lineCap = "round";
    for (const s of this.strokes) {
      octx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
      octx.strokeStyle = s.color;
      octx.lineWidth = s.size;
      const pts = s.points;
      octx.beginPath();
      octx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const mid = { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
        octx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, mid.x, mid.y);
      }
      octx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      octx.stroke();
    }
    return out.toDataURL("image/png");
  }
}
