// model-relay.js — autonomous model-to-model relay via opencode's native API.
//
// THE FEATURE: /relay wires the human OUT of a
// two-model dialogue. When active, one session's responses are automatically
// forwarded as prompts to its partner; the partner's responses come back.
// Ping-pong for N forwards, or indefinitely with -1.
//
// PAYLOAD TRANSPORT: a forwarded response is
// NEVER truncated. Small payloads ride inline; large ones are stored once on
// disk and passed as a ref the partner derefs with its own file-read tool —
// a content-ref pattern at the plugin layer. INLINE_LIMIT picks the
// transport, never cuts content. Set INLINE_LIMIT=0 to always pass refs.
//
// COMMAND CHANNEL (measured live): the V2 prompt hook fires on every
// admitted prompt but exposes ONLY event.sessionID — no text (the
// prompt-hook-no-text warning fires once per process to document this). So
// /relay is parsed at TURN COMPLETION instead: the session context is read,
// and if the user message immediately preceding the final assistant response
// is a /relay command not yet handled, it executes there. For `on`, the
// assistant's answer to the command IS forward #1 — the visible ack is the
// bootstrap. Dedup: an exact command text is handled once per process, and a
// command whose answer already exists never re-fires after a restart because
// the (command, answer) pair is only acted on when it is the session tail.
//
// PROVEN API SURFACES (measured live):
//   - ctx.session.context({sessionID}) — messages discriminate on .type
//     ("assistant"/"user"), text lives in content[] — NOT .role/.parts.
//   - ctx.session.prompt({sessionID, text}) — inject a real turn.
//   - one assistant turn spans MANY session.step.ended events → we debounce
//     with a quiet window (QUIET_MS) before processing, so a mid-tool-call
//     turn is never forwarded as if final.
//
// SPEAKER MODEL: exactly one side is "the speaker" whose completions forward.
// Forward flips the speaker. A manual prompt to the speaker session relays;
// a manual prompt to the waiting side stays local.
//
// USAGE:  /relay on <partner-session-id> [turns]   (turns: -1 = indefinite)
//         /relay off
//         /relay status
//
// State persists to <RELAY_HOME>/relay-state.json across restarts.

import { Plugin } from "@opencode/plugin";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const INLINE_LIMIT = 16 * 1024;      // below: forward inline; above: store a ref
const QUIET_MS = 2500;               // step-quiet window before a turn is processed
// ---- CONFIG (A3): single block, tool-namespaced defaults. Override with
// MODEL_RELAY_HOME for a custom root. Default is the portable
// ~/.config/opencode/relay; an existing ~/.multiaim relay-state.json marks a
// legacy install and keeps its home so state survives upgrades.
const LEGACY_HOME = join(homedir(), ".multiaim");
const DEFAULT_HOME = join(homedir(), ".config", "opencode", "relay");
const RELAY_HOME = process.env.MODEL_RELAY_HOME
  || (existsSync(join(LEGACY_HOME, "relay-state.json")) ? LEGACY_HOME : DEFAULT_HOME);
mkdirSync(RELAY_HOME, { recursive: true });
const REF_DIR = join(RELAY_HOME, "relay-refs");
const STATE_FILE = join(RELAY_HOME, "relay-state.json");
const LOCK_DIR = join(RELAY_HOME, "relay-locks");
const LOG_FILE = join(RELAY_HOME, "relay-status.jsonl");
const LOCK_MAX_AGE_MS = 15 * 60 * 1000;
const REF_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const TURN_DONE = new Set([
  "session.step.ended", "session.turn.completed", "session.completed",
]);

// CROSS-INSTANCE IDEMPOTENCY (measured live: SIX plugin instances —
// 2 windows x 3 loads — each handled the same turn-end and each notified,
// delivering the self-relay refusal six times). mkdir is atomic on every
// filesystem we run on: the one instance that creates the lock dir acts,
// every other instance skips. Locks are pruned when older than
// LOCK_MAX_AGE_MS so a crashed holder cannot wedge the relay forever.
function tryLock(key) {
  try {
    // The PARENT must exist or the atomic leaf-mkdir throws ENOENT — which the
    // catch below would misread as "another instance owns this action" and
    // silence EVERY relay action (measured live: total silence at the
    // first live self-relay attempt). Parent creation is idempotent; only the
    // LEAF mkdir carries the atomicity that picks the one acting instance.
    mkdirSync(LOCK_DIR, { recursive: true });
    // Lesson 2 (measured live): prune BEFORE the leaf
    // attempt. The old placement pruned only on the SUCCESS path, so on
    // EEXIST — the failing path — stale locks from a COMPLETED relay run
    // were never cleaned (17 locks from the 07:03 run blocked the 19:22
    // re-arming forever; the arm-time prune missed it via the dedup path).
    // Pruning here heals every stale case at the moment it matters.
    // LESSON 3 (caught by unit test the same night): the locks are
    // DIRECTORIES, and unlinkSync(3) refuses directories (EISDIR) — the
    // swallowed catch made every prior prune a silent no-op. rmSync it.
    try {
      for (const f of readdirSync(LOCK_DIR)) {
        const p = join(LOCK_DIR, f);
        try {
          if (Date.now() - statSync(p).mtimeMs > LOCK_MAX_AGE_MS) rmSync(p, { recursive: true, force: true });
        } catch (e) { log("debug", "prune is best-effort: " + e?.message); }
      }
    } catch (e) { log("debug", "prune is best-effort: " + e?.message); }
    mkdirSync(join(LOCK_DIR, key), { recursive: false });
    return true;
  } catch {
    return false; // EEXIST even after pruning: a LIVE instance owns this action
  }
}

// OBSERVABILITY: one JSON line per transition, closed vocabulary, rotated.
// Vocabulary (everything else is a bug in the logging, not a new event):
//   armed seeded forwarded received lock-held cmd-dedup cmd-skip empty-skip
//   complete dropped warn
const LOG_EVENTS = new Set([
  "armed", "seeded", "forwarded", "received", "lock-held", "cmd-dedup",
  "cmd-skip", "empty-skip", "complete", "dropped", "warn",
  // legacy event names kept so old lines stay readable; they map to the
  // closed set at write time
]);
const LEGACY_EVENT_MAP = {
  "relay-on": "armed", "relay-on-self": "armed", "relay-seed": "seeded",
  "relay-off": "dropped", "relay-complete": "complete", "forward": "forwarded",
  "fwd-lock-held": "lock-held", "cmd-lock-held": "cmd-skip",
  "relay-command-dedup": "cmd-dedup", "empty-response": "empty-skip",
  "state-restored": "armed", "loaded": "armed", "setup-start": "warn",
  "state-restore-failed": "warn", "context-read-failed": "warn",
  "prompt-hook-no-text": "cmd-skip", "empty-response": "empty-skip",
  "partner-gone": "dropped", "relay-command-error": "warn",
};
const LOG_MAX_LINES = 10000;
let CURRENT_SID = null;

function stableShortId(sid) {
  // STABLE short id: same bytes in every event, every code path — the log
  // join key must not vary by slice position (receipt-side contract).
  let h = 0;
  for (let i = 0; i < sid.length; i++) h = ((h << 5) - h + sid.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function log(state, detail, extra) {
  const event = LOG_EVENTS.has(state) ? state : (LEGACY_EVENT_MAP[state] || "warn");
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(), event,
      self: CURRENT_SID ? stableShortId(CURRENT_SID) : null,
      detail: detail || "",
      ...(extra || {}),
    }) + "\n";
    appendFileSync(LOG_FILE, line);
    rotateLogIfLarge();
  } catch (e) {
    // best-effort BY DESIGN, but never invisible (A5): stderr is the floor.
    try { console.error("[model-relay] log write failed:", e?.message || e); } catch { /* explicit carve: nothing left */ }
  }
}

function rotateLogIfLarge() {
  try {
    const st = statSync(LOG_FILE);
    if (st.size < 2_000_000) return; // ~10k lines; cheap size proxy
    const lines = readFileSync(LOG_FILE, "utf8").split("\n");
    writeFileSync(LOG_FILE + ".tmp", lines.slice(-LOG_MAX_LINES).join("\n"));
    renameSync(LOG_FILE + ".tmp", LOG_FILE);
  } catch (e) { log("debug", "rotation is best-effort; the append already succeeded: " + e?.message); }
}

function storeRef(text, sid) {
  mkdirSync(REF_DIR, { recursive: true });
  const refPath = join(REF_DIR, `${Date.now()}-${sid.slice(4, 16)}.md`);
  writeFileSync(refPath, text);
  try {
    for (const f of readdirSync(REF_DIR)) {
      const p = join(REF_DIR, f);
      if (Date.now() - statSync(p).mtimeMs > REF_MAX_AGE_MS) unlinkSync(p);
    }
  } catch (e) { log("debug", "prune is best-effort: " + e?.message); }
  return refPath;
}

function parseRelayCommand(text) {
  const parts = text.trim().split(/\s+/);
  if (parts[0] !== "/relay") return null;
  const sub = parts[1]?.toLowerCase();
  if (sub === "off") return { action: "off" };
  if (sub === "status") return { action: "status" };
  if (sub === "on") {
    // Dashed flags (e.g. -s) are skipped ONLY in the leading position
    // between `on` and the partner id. The first cut filtered dash-prefixed
    // tokens EVERYWHERE — a seed like "use --force and -v flags" was being
    // mangled (a partner-side finding).
    let i = 2;
    while (i < parts.length && parts[i].startsWith("-") && parts[i].length > 1 && parts[i] !== "--") i++;
    const rest = parts.slice(i);
    const partner = rest[0];
    if (!partner || partner.startsWith("-")) return { action: "error", message: "usage: /relay on [-flag] <partner-session-id> [turns] [seed prompt]" };
    // TURNS (lenient — a suite-found fix): the old code errored on a
    // non-numeric rest[1] BEFORE the seed fallback could run, leaving the
    // "no turns given: rest is the seed" branch dead code — so
    // `/relay on <id> please proceed` errored instead of arming indefinite
    // with that seed. Now a non-numeric rest[1] means turns defaults to -1
    // and the rest becomes the seed. An EXPLICIT numeric turns (including -1)
    // is honored as turns, preserving the old edge behavior.
    const parsedTurns = rest.length > 1 ? parseInt(rest[1], 10) : NaN;
    const turns = Number.isNaN(parsedTurns) ? -1 : parsedTurns;
    // SEED: everything after the turns
    // argument is the bootstrap prompt -- the words the operator types
    // around the command are the exchange's opening, not noise to discard.
    // Delivered as an explicit kickoff prompt at arm time (uncounted -- it
    // is turn zero, not forward #1).
    const seed =
      !Number.isNaN(parsedTurns) && rest.length > 2
        ? rest.slice(2).join(" ").trim()
        : Number.isNaN(parsedTurns) && rest.length > 1
          ? rest.slice(1).join(" ").trim() // no turns given: rest is the seed
          : "";
    return { action: "on", partner, turns, seed };
  }
  return { action: "error", message: "usage: /relay on <id> [turns] [seed] | off | status" };
}

function messageText(message) {
  if (!message) return "";
  if (Array.isArray(message.content)) {
    return message.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  }
  // USER messages persist as {type:"user", text:"..."} (measured in
  // session_message: top-level "text", no content[]) while assistant messages
  // carry content[] (the tells-proven shape). Read both; never guess.
  if (typeof message.text === "string") return message.text;
  return String(message.content ?? "");
}

// CRASH-SAFE ARM — the dead-arm recovery (cure for the mid-arm silent death).
// An instance writes its arm intent before anything else; if the process
// dies mid-arm, the intent survives as a fingerprint. Any later instance
// that finds a STALE intent completes the arm from it. The decision is a
// pure function so the suite pins it.
function readArmIntent() {
  try {
    return readFileSync(join(RELAY_HOME, "relay-arm-intent.json"), "utf8");
  } catch {
    return null;
  }
}

function deadArmFromIntent(intentJson, now = Date.now()) {
  if (!intentJson) return null;
  try {
    const intent = JSON.parse(intentJson);
    // A live arm clears its intent within milliseconds; 30s is well past any
    // legitimate in-flight arm, so a stale intent means the armer died.
    if (now - (intent?.ts ?? 0) > 30_000 && intent?.sid && intent?.partner) {
      return intent.sid === intent.partner
        ? { self: intent.sid, turns: intent.turns ?? -1 }
        : { sid: intent.sid, partner: intent.partner, turns: intent.turns ?? -1 };
    }
  } catch (e) { log("warn", "corrupt or unreadable — no recovery: " + e?.message); }
  return null;
}

export default Plugin.define({
  id: "model-relay",
  async setup(ctx) {
    log("setup-start");
    const relays = new Map();   // sid -> { partner, turns, count, speaker }
    const quietTimers = new Map();
    // A1: exact command text per session, once per process — CAPPED so a
    // long-lived window does not grow the Set without bound.
    const handledCommands = new Set();
    const HANDLED_COMMANDS_MAX = 500;
    function rememberCommand(key) {
      handledCommands.add(key);
      if (handledCommands.size > HANDLED_COMMANDS_MAX) {
        const first = handledCommands.values().next().value;
        handledCommands.delete(first);
      }
    }

    function saveState() {
      // A2 (atomic): each writer temps under its own pid then renames —
      // concurrent windows never interleave, and a reader sees the whole
      // old state or the whole new one. Warn loudly on failure (A5).
      const tmp = STATE_FILE + ".tmp-" + process.pid;
      try {
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(relays), null, 2));
        renameSync(tmp, STATE_FILE);
      } catch (e) {
        log("warn", "state-save-failed: " + (e && e.message));
        try { unlinkSync(tmp); } catch { /* explicit carve: tmp already gone */ }
      }
    }

    function loadState() {
      try {
        if (!existsSync(STATE_FILE)) return;
        const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
        for (const [sid, r] of Object.entries(raw)) {
          if (r?.partner) relays.set(sid, { partner: r.partner, turns: r.turns ?? -1, count: r.count ?? 0, speaker: !!r.speaker });
        }
        log("state-restored", `${relays.size} entries`);
      } catch (err) { log("state-restore-failed", String(err)); }
    }

    function drop(sid) {
      const r = relays.get(sid);
      if (r) relays.delete(r.partner);
      relays.delete(sid);
      saveState();
    }

    async function notify(sid, text) {
      try { await ctx.session.prompt({ sessionID: sid, text }); } catch (e) { log("debug", "session may be gone: " + e?.message); }
    }

    function statusText(sid) {
      const r = relays.get(sid);
      const lines = [];
      // SOURCE 1: state
      if (r) {
        lines.push(`[RELAY] Active: you <-> ${r.self ? "self" : stableShortId(r.partner)} · forwards ${r.count}/${r.turns === -1 ? "∞" : r.turns} · you are ${r.speaker ? "the speaker" : "waiting"}`);
      } else {
        lines.push("[RELAY] No active relay for this session.");
      }
      // SOURCE 2: the last 20 events touching this session, newest last
      try {
        const raw = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).slice(-200);
        const me = stableShortId(sid);
        const mine = raw
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((e) => e && (e.self === me || (e.partner && e.partner === me)))
          .slice(-20);
        if (mine.length) {
          lines.push("events (oldest first):");
          for (const e of mine) lines.push(`  ${String(e.ts || "").slice(11, 19)} ${e.event} ${e.detail || ""}`.slice(0, 120));
        } else {
          lines.push("events: none recorded for this session");
        }
      } catch {
        lines.push("events: log unreadable");
      }
      // SOURCE 3: lock census
      try {
        const entries = readdirSync(LOCK_DIR).filter((f) => f.startsWith("fwd-"));
        const now = Date.now();
        let stale = 0;
        for (const f of entries) {
          try { if (now - statSync(join(LOCK_DIR, f)).mtimeMs > LOCK_MAX_AGE_MS) stale++; } catch (e) { log("debug", "census best-effort: " + e?.message); }
        }
        lines.push(`locks: ${entries.length} total (${stale} stale; the reaper or sweep reclaims at TTL)`);
      } catch {
        lines.push("locks: dir unreadable");
      }
      // SOURCE 4: this instance's content hash — the instance-skew detector
      try {
        const self = readFileSync(process.argv[1] || import.meta.url.replace("file://", ""), "utf8");
        let h = 0;
        for (let i = 0; i < self.length; i++) h = ((h << 5) - h + self.charCodeAt(i)) | 0;
        lines.push(`instance: v2-${(h >>> 0).toString(36)} (mixed versions across windows? compare hashes)`);
      } catch {
        lines.push("instance: hash unreadable");
      }
      return lines.join("\n");
    }

    // one context read serves both the command scan and the forward
    function scanTail(messages) {
      const msgs = Array.isArray(messages) ? messages : [];
      let lastAssistant = null;
      let iA = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.type === "assistant") { lastAssistant = msgs[i]; iA = i; break; }
      }
      let priorUserText = "";
      if (iA > 0) {
        for (let i = iA - 1; i >= 0; i--) {
          if (msgs[i]?.type === "user") {
            const t = messageText(msgs[i]);
            const trimmed = t.trimStart();
            // INJECTED user messages are not the human's prompt: the tells
            // hook's [TELL] nudge and this plugin's own [RELAY] envelopes land
            // as user messages BETWEEN the command and the reply (measured
            // measured live: priorText was another plugin's [TELL] nudge, not the /relay command
            // — the two plugins stepped on each other through five failed
            // tests). Skip them to find the human's actual words.
            if (trimmed.startsWith("[TELL]") || trimmed.startsWith("[RELAY")) continue;
            priorUserText = t;
            break;
          }
        }
      }
      return { lastAssistant, priorUserText };
    }

    async function processTurnEnd(sid) {
      let messages;
      try {
        messages = await ctx.session.context({ sessionID: sid });
      } catch (err) {
        log("context-read-failed", `${sid}: ${err}`);
        return;
      }
      const { lastAssistant, priorUserText } = scanTail(messages);

      // command channel: an unhandled /relay command that the final assistant
      // response just answered. A slash turn that scans as nothing is LOGGED —
      // the no-op path is never silent (the fail-loud rule, enforced).
      if (priorUserText.startsWith("/relay")) {
        // The lock is scoped PER TURN (the assistant message id): multiple
        // plugin instances of the SAME turn dedup (measured 6x fan-out), but
        // the NEXT turn — which re-detects the same command text after
        // skipping the [RELAY] envelope — takes a FRESH lock. A content-only
        // hash strangled the loop after exactly one forward (measured
        // measured live: armed, count=1, then silence — the stale cmd-lock
        // return killed the forward flow).
        const turnKey = String(lastAssistant?.id ?? "noturn").slice(-20);
        const cmdHash = `${turnKey}-${priorUserText.trim().length}-${priorUserText.trim().slice(-16)}`;
        if (!tryLock(`cmd-${cmdHash.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 90)}`)) {
          log("cmd-lock-held", `turn=${turnKey} (another instance handled this turn's command)`);
          return;
        }
        const key = `${sid}|${priorUserText.trim()}`;
        if (handledCommands.has(key)) {
          log("relay-command-dedup", key.slice(0, 60));
        } else {
          rememberCommand(key);
          const cmd = parseRelayCommand(priorUserText);
          if (cmd?.action === "on") {
            // CRASH-SAFE ARM (the mid-arm death cure): write the intent
            // BEFORE anything else. A process death between here and the
            // state write leaves the intent as a visible fingerprint, and
            // any later instance recovers the arm from it. Measured twice:
            // both deaths were silent because nothing marked the in-flight
            // arm.
            try {
              writeFileSync(join(RELAY_HOME, "relay-arm-intent.json"), JSON.stringify({ sid, partner: cmd.partner, turns: cmd.turns, ts: Date.now() }));
            } catch (e) { log("warn", "best-effort — the arm proceeds as before: " + e?.message); }
            if (cmd.partner === sid) {
              // SELF-RELAY (by design): the session relays
              // to itself — a self-dialogue loop where each reply is re-seeded
              // by the previous one. One entry, always the speaker; the
              // command's answer is self-forward #1.
              // Lesson: prune forward locks older than 2h at ARM time —
              // a prior test's fwd-<sid>-<n> locks must not strangle this
              // activation's forwards (the tells-plugin prune lesson).
              try {
                const LOCK_AGE_MS = 2 * 60 * 60 * 1000;
                for (const f of readdirSync(LOCK_DIR)) {
                  if (!f.startsWith("fwd-")) continue;
                  try {
                    const p = join(LOCK_DIR, f);
                    // Lesson 3: locks are directories -- unlinkSync
                    // refuses them (EISDIR) and the swallowed catch made this
                    // arm-time prune a silent no-op too. rmSync it.
                    if (Date.now() - statSync(p).mtimeMs > LOCK_AGE_MS) rmSync(p, { recursive: true, force: true });
                  } catch (e) { log("debug", "prune is best-effort: " + e?.message); }
                }
              } catch (e) { log("debug", "prune is best-effort: " + e?.message); }
              relays.set(sid, { partner: sid, turns: cmd.turns, count: 0, speaker: true, self: true });
              saveState();
              try { rmSync(join(RELAY_HOME, "relay-arm-intent.json"), { force: true }); } catch (e) { log("debug", "best-effort: " + e?.message); }
              log("relay-on-self", `${sid} turns=${cmd.turns}`);
            } else {
              relays.set(sid, { partner: cmd.partner, turns: cmd.turns, count: 0, speaker: true });
              relays.set(cmd.partner, { partner: sid, turns: cmd.turns, count: 0, speaker: false });
              saveState();
              try { rmSync(join(RELAY_HOME, "relay-arm-intent.json"), { force: true }); } catch (e) { log("debug", "best-effort: " + e?.message); }
              log("relay-on", `${sid} <-> ${cmd.partner} turns=${cmd.turns}`);
            }
            // SEED: an explicit bootstrap
            // prompt in the command tail becomes the exchange's turn zero --
            // delivered at arm time, uncounted (the command's own answer is
            // still forward #1). Without a seed the behavior is unchanged.
            if (cmd.seed) {
              log("relay-seed", `${sid}: ${cmd.seed.slice(0, 60)}`);
              const seedB64 = Buffer.from(cmd.seed, "utf8").toString("base64");
              await notify(cmd.partner, `[RELAY seed] Decode this base64 for the kickoff prompt:\n${seedB64}`);
            }
            // fall through: the assistant's answer to the command is forward #1
          } else if (cmd?.action === "off") {
            const r = relays.get(sid);
            drop(sid);
            log("relay-off", `${sid} (was: ${r ? r.partner : "none"})`);
            await notify(sid, "[RELAY] Deactivated.");
            return;
          } else if (cmd?.action === "status") {
            await notify(sid, statusText(sid));
            return;
          } else if (cmd) {
            await notify(sid, `[RELAY] ${cmd.message}`);
            return;
          }
        }
      }

      // forward flow
      // RELOAD FROM DISK every turn-end: the in-memory Map is stale the moment
      // another window (or a manual state write) arms a relay — the plugin
      // loads with 0 relays while the state file holds armed entries — every forward silently skips
      // because the Map never sees the state file's contents. The disk is the
      // source of truth; the Map is a cache that was never invalidated.
      try {
        const raw = readFileSync(STATE_FILE, "utf8");
        const disk = JSON.parse(raw);
        for (const [k, v] of Object.entries(disk)) {
          if (v?.partner && !relays.has(k)) relays.set(k, v);
        }
      } catch { /* explicit carve: no state file or unreadable — the Map stands */ }
      // DEAD-ARM RECOVERY: a stale intent file is the fingerprint of a
      // mid-arm process death. Runs AFTER the reload so saveState preserves
      // every armed entry, then arms what the dead process could not.
      const deadArm = deadArmFromIntent(readArmIntent());
      if (deadArm) {
        if (deadArm.self) {
          relays.set(deadArm.self, { partner: deadArm.self, turns: deadArm.turns, count: 0, speaker: true, self: true });
        } else {
          relays.set(deadArm.sid, { partner: deadArm.partner, turns: deadArm.turns, count: 0, speaker: true });
          relays.set(deadArm.partner, { partner: deadArm.sid, turns: deadArm.turns, count: 0, speaker: false });
        }
        saveState();
        log("arm-recovered", `dead arm completed from intent (${deadArm.self ? "self-relay" : `${stableShortId(deadArm.sid)} <-> ${stableShortId(deadArm.partner)}`})`);
        try { rmSync(join(RELAY_HOME, "relay-arm-intent.json"), { force: true }); } catch (e) { log("debug", "best-effort: " + e?.message); }
      }
      const relay = relays.get(sid);
      if (!relay || !relay.speaker) return;
      const text = messageText(lastAssistant);
      if (!text.trim()) { log("empty-response", sid.slice(0, 14)); return; }

      const partner = relays.get(relay.partner);
      if (!partner) { log("partner-gone", relay.partner.slice(0, 14)); relays.delete(sid); saveState(); return; }

      // one instance performs a given forward: post-restart loadState arms
      // EVERY instance, and the speaker flag alone does not dedup across
      // processes. Lock per (session, forward number).
      // Lesson: the count increments ONLY after the lock is won — a
      // lock-held return must not drift the counter (measured live:
      // stale test locks blocked forwards #5-#7 while every blocked attempt
      // still bumped the in-memory count, desyncing it from the state file).
      const nextCount = relay.count + 1;
      if (!tryLock(`fwd-${sid.slice(4, 16)}-${nextCount}`)) {
        log("fwd-lock-held", `#${nextCount} (another instance is forwarding)`);
        return;
      }
      relay.count = nextCount;
      saveState();
      if (relay.turns !== -1 && relay.count > relay.turns) {
        log("relay-complete", `${sid} <-> ${relay.partner}: ${relay.count - 1} forwards`);
        drop(sid);  // deactivate BEFORE notifying so the ack cannot forward
        await notify(sid, "[RELAY] Turn limit reached. Relay complete.");
        if (relay.partner !== sid) await notify(relay.partner, "[RELAY] Turn limit reached. Relay complete.");
        return;
      }

      // transport: inline fast path, ref for the heavy case — never truncated.
      // DELIVERY DEDUP (the multi-instance race cure): a hash of (sid, count,
      // text) identifies ONE crossing. The id persists in the relay's state
      // entry, so a second instance re-reading state from disk (the
      // reload-from-disk cure) skips the crossing by identity instead of
      // forwarding it twice. Bounded like the command set: no new leak class.
      const crypto = await import("node:crypto");
      const deliveryId = crypto
        .createHash("sha256")
        .update(`${sid}:${relay.count}:${text}`)
        .digest("hex")
        .slice(0, 16);
      relay.seen = relay.seen || [];
      if (relay.seen.includes(deliveryId)) {
        log("delivery-dedup", `${sid.slice(0, 14)} #${relay.count} id=${deliveryId} (already crossed)`);
        return;
      }
      relay.seen.push(deliveryId);
      if (relay.seen.length > 64) relay.seen.splice(0, relay.seen.length - 64);

      let payload;
      let mode = "inline";
      // BASE64 TRANSPORT: the payload rides as
      // base64 — collision-proof by construction. No sentinel grammar, no
      // delimiter rules, no "what can appear in prose" questions. The
      // receiver decodes before injecting, so the partner always sees
      // readable text. KISS.
      if (text.length <= INLINE_LIMIT) {
        const b64 = Buffer.from(text, "utf8").toString("base64");
        payload = `[RELAY from ${sid.slice(4, 16)}] Decode this base64 to read your partner's message, then reply directly. Your reply is sent back.\n${b64}`;
      } else {
        const refPath = storeRef(text, sid);
        mode = "ref";
        payload = `[RELAY from ${sid.slice(4, 16)}] Your partner's response is ${text.length} bytes — ` +
          `too large to inline. Full text stored at ref: ${refPath}\n` +
          `Read that file with your file tool, then reply; your reply is sent back.`;
      }

      relay.speaker = false;
      partner.speaker = true;
      try {
        await ctx.session.prompt({ sessionID: relay.partner, text: payload });
        log("forward", `${sid.slice(0, 14)} -> ${relay.partner.slice(0, 14)} #${relay.count} ${text.length}b ${mode}`);
        saveState();
      } catch (err) {
        log("forward-failed", `${sid.slice(0, 14)} -> ${relay.partner.slice(0, 14)}: ${err}`);
        drop(sid);
      }
    }

    function onStepEnded(sid) {
      if (quietTimers.has(sid)) clearTimeout(quietTimers.get(sid));
      quietTimers.set(sid, setTimeout(() => {
        quietTimers.delete(sid);
        void processTurnEnd(sid);
      }, QUIET_MS));
    }

    // session-id capture + the latched no-text diagnostic (see COMMAND CHANNEL)
    let warnedNoText = false;
    const onPrompt = (event) => {
      if (event.sessionID) { currentSessionID = event.sessionID; CURRENT_SID = event.sessionID; }
      const text = String(event.text ?? event.data?.text ?? "");
      if (!text && !warnedNoText) {
        warnedNoText = true;
        log("prompt-hook-no-text", "V2 prompt hook exposes no .text — /relay parsing lives at turn end (by design)");
      }
    };
    let currentSessionID = null;

    // event loop with restart backoff (the tells pattern)
    const controller = new AbortController();
    let streamRestarts = 0;
    async function runEventLoop() {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (TURN_DONE.has(event.type)) {
              const sid = event.data?.sessionID || event.sessionID || currentSessionID;
              if (sid) onStepEnded(sid);
            }
          } catch (e) { log("debug", "one bad event never kills the stream: " + e?.message); }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        streamRestarts += 1;
        log("stream-restart", `#${streamRestarts}: ${err}`);
        if (streamRestarts <= 5) {
          const t = setTimeout(() => { if (!controller.signal.aborted) void runEventLoop(); }, 30000 * streamRestarts);
          t.unref?.();
        }
      }
    }

    try { await ctx.session.hook("prompt", onPrompt); } catch (err) { log("prompt-hook-failed", String(err)); }
    loadState();
    void runEventLoop();
    log("loaded", `${relays.size} relays restored, inline<=${INLINE_LIMIT}b quiet=${QUIET_MS}ms cmd=turn-end`);
  },
});
