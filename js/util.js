// Small shared helpers: ids, room codes, text sanitising, DOM utilities.

export function randomCode() {
  // 6-digit numeric code, no leading zero so it always reads as 6 digits.
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function sessionToken() {
  return `st_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

const MAX_TEXT = 120;

export function sanitizeText(value) {
  if (typeof value !== "string") return "";
  // Strip control characters, collapse whitespace, clamp length.
  const cleaned = value
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_TEXT);
}

export const AVATAR_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#14b8a6", "#06b6d4",
  "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef",
  "#ec4899", "#f43f5e",
];

export function randomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Tiny DOM helper.
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
