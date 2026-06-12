# 🎨 Tinaftore

A peer-to-peer **write → draw → guess** party game for phones, inspired by the
classic "telephone" game. Everyone writes a sentence, someone draws it, someone
else guesses what the drawing was, and so on — then you reveal the gloriously
mangled chains.

**No backend, no database, no accounts.** It runs entirely in the browser and
is hosted on **GitHub Pages**. Players connect directly to each other over
**WebRTC**, with one player's browser acting as the authoritative "host".

---

## How it works

- The **host** creates a room and gets a **6-digit code**.
- Friends open the same site, type the code, and join. (A share link with the
  code in the URL also works — `…/#123456`.)
- The host's browser runs the game engine: it decides assignments, runs the
  round timers, and tells every device what to show. Clients never decide game
  state on their own.
- Connections use **PeerJS's free public broker** *only for the WebRTC
  handshake*. All game data (prompts, drawings, guesses) flows directly
  peer-to-peer.

### Game flow
```
Lobby → Round 1: everyone writes a prompt
      → Round 2: everyone draws someone's prompt
      → Round 3: everyone guesses someone's drawing
      → … alternating draw/guess until every chain has one entry per player
      → Reveal each chain → download / play again
```
Assignment rotation per round: `chainIndex = (playerIndex - (round-1) + N) % N`.

## Architecture

| Concern | Implementation |
|---|---|
| Hosting | GitHub Pages (static files, **no build step**) |
| Transport | WebRTC data channels via [PeerJS](https://peerjs.com) |
| Topology | Star — clients connect to the host; host relays + validates |
| Authority | Host browser runs `js/engine.js` (the state machine) |
| State | In-memory on host + a localStorage snapshot for refresh recovery |
| Drawings | Canvas → downscaled PNG data URL, sent over the data channel |

```
index.html            # shell, loads PeerJS (CDN) + the ES module app
styles.css            # mobile-first styling
js/
  main.js             # bootstrap: host/client wiring, message routing, recovery
  engine.js           # AUTHORITATIVE game engine + state machine (host only)
  net.js              # PeerJS host/client wrappers, auto-reconnect
  protocol.js         # message types, constants, round/task rules
  store.js            # reactive client view store
  ui.js               # all screens (home, lobby, rounds, waiting, reveal)
  canvas.js           # pointer-based drawing canvas (undo/redo, PNG export)
  actions.js          # UI → network action bridge
  util.js             # ids, room codes, sanitisation, DOM helpers
.github/workflows/pages.yml  # auto-deploy to GitHub Pages
```

### Message map (replaces the spec's Socket.IO events)
- **Client → Host:** `join`, `updateProfile`, `updateSettings`, `startGame`,
  `submitText`, `submitDrawing`, `reaction`, `kick`, `playAgain`, `leave`
- **Host → Client:** `joined`, `roomState`, `roundStarted`, `roundProgress`,
  `roundEnded`, `revealStarted`, `reactionNew`, `error`, `kicked`, `hostClosed`

### State machine (host)
`LOBBY → ROUND_PREPARE → ROUND_ACTIVE → ROUND_COMPLETE → (loop) → REVEAL → FINISHED`

A round ends when **all players submit** *or* the **server-side timer expires**
(timeouts insert a "(no answer)" / blank-drawing fallback). The frontend timer
is visual only.

---

## Run locally
Because it uses ES modules, serve it over HTTP (not `file://`):
```bash
# any static server works
python3 -m http.server 8000
# then open http://localhost:8000
```
Open it in several tabs/devices to simulate players. **Minimum 3 players.**

## Deploy to GitHub Pages
The included workflow deploys automatically on push. One-time setup:
1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `claude/multiplayer-webrtc-game-fl3ax3` (or `main`).
3. The site publishes at `https://<user>.github.io/<repo>/`.

Alternatively, **Settings → Pages → Deploy from a branch** (root) also works —
the site is just static files.

---

## Trade-offs & limitations (P2P, no server)
- **Host = server.** If the host *closes* the tab, the room ends. A host
  *refresh* recovers from a localStorage snapshot; clients auto-reconnect.
- **Public broker dependency.** PeerJS's free broker is used for connection
  setup only. For guaranteed uptime, self-host a tiny `PeerServer` and point
  `net.js` at it (this would no longer be pure GitHub Pages).
- **NAT traversal / TURN.** `net.js` ships public STUN servers plus a free
  public TURN relay (OpenRelay) so phones on mobile data can still connect.
  The free TURN relay is best-effort; for reliable production use, plug in your
  own TURN (coturn) or a TURN provider key in `ICE_SERVERS`.
- **Host must stay open.** The host's tab is the server. The host now
  auto-re-registers with the broker after idle/background drops, and clients
  retry + auto-reconnect — but if the host fully closes the tab, the room ends.
- **Scale.** Designed for small friend groups (3–16). Star topology means the
  host uploads to every peer; very large drawings × many players will strain a
  weak host connection.
- **No moderation / persistence.** Private rooms only; nothing is stored server
  side. This matches the MVP scope.

## Possible next steps
Self-hosted signalling for reliability, host-migration mid-game, stroke-replay
animations in reveal, sound effects, light/dark theme, more game modes.
