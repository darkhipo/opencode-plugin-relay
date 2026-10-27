// model-relay.test.mjs — the export's immune system.
//
// One file, four sections, seventeen cases, zero dependencies (node only).
// Run:  node model-relay.test.mjs     (exit 0 = all pass)
//
// PROVENANCE: tryLock(), parseRelayCommand() and messageText() are extracted
// from model-relay.js — executable lines verbatim, lesson comments
// abridged. If you change them in the plugin, change them here in the same
// edit: this file pins their semantics, and a divergence between the two
// copies is a bug in one of them. tryLock's LOCK_DIR is rebound to a scratch
// directory so the suite never touches the live lock namespace.
//
// Sections:
//   1. tryLock     (4 cases) — the instance-election primitive
//   2. parse       (8 cases) — the /relay command grammar
//   3. base64      (3 cases) — the transport contract (the S1 fixture reborn)
//   4. messageText (2 cases) — the turn-text extraction shapes
//
// The suite's first catch came before it shipped: consolidating it found the
// parser's no-turns seed fallback was DEAD CODE (the "turns must be a number"
// error returned first), so `/relay on <id> please proceed` errored instead
// of arming indefinite with that seed. Case 2.4 pins the fix.

import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
// log shim: the extracted copy calls the plugin's log(); captured for the
// forced error-path case below.
const logLines = [];
function log(event, detail) { logLines.push(String(detail)); }
function check(name, ok) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Section 1: tryLock — mkdir-as-lock instance election.
// The parent must exist (leaf ENOENT misreads as "held"); prune BEFORE the
// leaf attempt (the EEXIST path never pruned on its own); locks are
// DIRECTORIES so prune is rmSync, never unlinkSync.
// ─────────────────────────────────────────────────────────────────────────

const LOCK_DIR = "/tmp/model-relay-test-locks";
const LOCK_MAX_AGE_MS = 15 * 60 * 1000;
rmSync(LOCK_DIR, { recursive: true, force: true });

function tryLock(key) {
  try {
    mkdirSync(LOCK_DIR, { recursive: true });
    try {
      for (const f of readdirSync(LOCK_DIR)) {
        const p = join(LOCK_DIR, f);
        try {
          if (Date.now() - statSync(p).mtimeMs > LOCK_MAX_AGE_MS) rmSync(p, { recursive: true, force: true });
        } catch { /* prune is best-effort */ }
      }
    } catch { /* prune is best-effort */ }
    mkdirSync(join(LOCK_DIR, key), { recursive: false });
    return true;
  } catch {
    return false;
  }
}

console.log("tryLock:");
// 1.1 fresh namespace → the lock wins
check("fresh lock wins", tryLock("fwd-1") === true);
// 1.2 the SAME lock held fresh (a live peer) → refused
check("live-held lock refuses", tryLock("fwd-1") === false);
// 1.3 a STALE lock (> TTL) at the target → pruned by the pre-attempt sweep → wins
mkdirSync(join(LOCK_DIR, "fwd-2"), { recursive: false });
const old = new Date(Date.now() - 20 * 60 * 1000);
utimesSync(join(LOCK_DIR, "fwd-2"), old, old);
check("stale lock is reclaimed", tryLock("fwd-2") === true);
// 1.4 the reclaim also SWEEPS other stale locks in the namespace
mkdirSync(join(LOCK_DIR, "fwd-3"), { recursive: false });
utimesSync(join(LOCK_DIR, "fwd-3"), old, old);
tryLock("fwd-4");
check("reclaim sweeps stale siblings", !readdirSync(LOCK_DIR).includes("fwd-3"));
rmSync(LOCK_DIR, { recursive: true, force: true });

// ─────────────────────────────────────────────────────────────────────────
// Section 2: parseRelayCommand — the /relay grammar.
// Dashed flags are skipped ONLY in leading position between `on` and the
// partner id (a seed like "use --force and -v flags" must survive whole).
// A non-numeric second token means: no turns given → turns default -1 and
// the rest IS the seed (the suite-found dead-branch fix, 2026-10-26).
// ─────────────────────────────────────────────────────────────────────────

function parseRelayCommand(text) {
  const parts = text.trim().split(/\s+/);
  if (parts[0] !== "/relay") return null;
  const sub = parts[1]?.toLowerCase();
  if (sub === "off") return { action: "off" };
  if (sub === "status") return { action: "status" };
  if (sub === "on") {
    let i = 2;
    while (i < parts.length && parts[i].startsWith("-") && parts[i].length > 1 && parts[i] !== "--") i++;
    const rest = parts.slice(i);
    const partner = rest[0];
    if (!partner || partner.startsWith("-")) return { action: "error", message: "usage: /relay on [-flag] <partner-session-id> [turns] [seed prompt]" };
    const parsedTurns = rest.length > 1 ? parseInt(rest[1], 10) : NaN;
    const turns = Number.isNaN(parsedTurns) ? -1 : parsedTurns;
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

console.log("parse:");
// 2.1 the Emissary's flag arming: -s skipped, turns 4, seed intact
check(
  "flag arming parses",
  (() => {
    const r = parseRelayCommand("/relay on -s ses_f3ee11eeaffeJqJE77jjj9Ccxl 4 now you get to try the real deal. Talking to more than just yourself.");
    return r.action === "on" && r.partner === "ses_f3ee11eeaffeJqJE77jjj9Ccxl" && r.turns === 4 && r.seed.startsWith("now you get");
  })()
);
// 2.2 plain arming: partner, turns, seed
check(
  "plain arming parses",
  (() => {
    const r = parseRelayCommand("/relay on ses_ff1b63114ffevZlMnfRiGJ7rrA 16 please proceed");
    return r.action === "on" && r.partner === "ses_ff1b63114ffevZlMnfRiGJ7rrA" && r.turns === 16 && r.seed === "please proceed";
  })()
);
// 2.3 turns without a seed → seed empty
check(
  "turns-only leaves seed empty",
  (() => {
    const r = parseRelayCommand("/relay on ses_x 4");
    return r.action === "on" && r.turns === 4 && r.seed === "";
  })()
);
// 2.4 THE FIX: seed without turns → arms indefinite (-1), rest is the seed
check(
  "seed without turns arms indefinite (dead-branch fix)",
  (() => {
    const r = parseRelayCommand("/relay on ses_x please proceed with this");
    return r.action === "on" && r.turns === -1 && r.seed === "please proceed with this";
  })()
);
// 2.5 flag-like tokens INSIDE the seed survive whole (leading-position-only skip)
check(
  "dashes inside seed survive",
  (() => {
    const r = parseRelayCommand("/relay on ses_x 8 use --force and -v flags tonight");
    return r.action === "on" && r.turns === 8 && r.seed === "use --force and -v flags tonight";
  })()
);
// 2.6 explicit -1 turns is a NUMBER, not a flag and not a seed token
check(
  "explicit indefinite turns honored",
  (() => {
    const r = parseRelayCommand("/relay on ses_x -1 forever");
    return r.action === "on" && r.turns === -1 && r.seed === "forever";
  })()
);
// 2.7 bare /relay on → usage error
check(
  "bare on errors",
  parseRelayCommand("/relay on").action === "error"
);
// 2.8 off
check("off parses", parseRelayCommand("/relay off").action === "off");

// ─────────────────────────────────────────────────────────────────────────
// Section 3: base64 transport — the S1 fixture reborn.
// The old sentinel grammar needed a reject-at-station check because a
// payload containing the markers could be double-wrapped. Base64 makes the
// question moot: the wire form is pure alphabet, nothing in prose can
// collide with it, and the payload that the old code REJECTED now rides
// without ceremony.
// ─────────────────────────────────────────────────────────────────────────

console.log("base64:");
const adversarial =
  "⟦relay-payload⟧ text that STARTS with the old open marker — the exact shape the old S1 check rejected.\n\n" +
  "Prose with the old markers ⟦relay-payload⟧ and ⟦/relay-payload⟧ inline, a fence --- line ---, " +
  'a colon: unicode café ☕ and quotes "both" kinds \'here\'.';
const wire = Buffer.from(adversarial, "utf8").toString("base64");
// 3.1 round-trip is byte-identical on the adversarial corpus
check(
  "round-trip byte-identical",
  Buffer.from(wire, "base64").toString("utf8") === adversarial
);
// 3.2 the wire carries no collision glyphs — markers, fences, none possible
check(
  "wire is collision-free",
  !wire.includes("⟦") && !wire.includes("⟧") && !wire.includes("---") && !wire.includes("\n")
);
// 3.3 the old S1 reject shape transports clean — no sentinel to double-apply
check(
  "old S1 reject shape rides whole",
  (() => {
    const back = Buffer.from(wire, "base64").toString("utf8");
    return back.trimStart().startsWith("⟦relay-payload⟧") && back === adversarial;
  })()
);

// ─────────────────────────────────────────────────────────────────────────
// Section 4: messageText — both persisted message shapes, never guess.
// User messages persist as {type:"user", text:"..."} (top-level text, no
// content[]) while assistant messages carry content[] (the tells-proven
// shape, measured 2026-10-25).
// ─────────────────────────────────────────────────────────────────────────

function messageText(message) {
  if (!message) return "";
  if (Array.isArray(message.content)) {
    return message.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  }
  if (typeof message.text === "string") return message.text;
  return String(message.content ?? "");
}

console.log("messageText:");
// 4.1 assistant shape: content[] parts, ONLY text parts extracted, joined
check(
  "assistant content[] shape",
  messageText({ content: [{ type: "text", text: "line one" }, { type: "tool", name: "x" }, { type: "text", text: "line two" }] }) ===
    "line one\nline two"
);
// 4.2 user shape: top-level text string
check("user top-level text shape", messageText({ text: "plain words" }) === "plain words");

// ─────────────────────────────────────────────────────────────────────────
// Section 5: dead-arm recovery — the crash-safe arm's decision function.
// An arming instance writes intent before anything else; a process death
// mid-arm leaves the intent as a fingerprint. Any later instance that finds
// a STALE intent (> 30s — a live arm clears within milliseconds) completes
// the arm from it. Silent deaths become visible AND recoverable.
// ─────────────────────────────────────────────────────────────────────────

function deadArmFromIntent(intentJson, now = Date.now()) {
  if (!intentJson) return null;
  try {
    const intent = JSON.parse(intentJson);
    if (now - (intent?.ts ?? 0) > 30_000 && intent?.sid && intent?.partner) {
      return intent.sid === intent.partner
        ? { self: intent.sid, turns: intent.turns ?? -1 }
        : { sid: intent.sid, partner: intent.partner, turns: intent.turns ?? -1 };
    }
  } catch (err) { log("warn", "arm intent unreadable/corrupt — dead-arm recovery skipped: " + (err?.message || err)); }
  return null;
}

console.log("dead-arm recovery:");
// 5.1 stale two-party intent → the recovery spec carries both sides
check(
  "stale two-party intent recovers",
  (() => {
    const r = deadArmFromIntent(JSON.stringify({ sid: "ses_a", partner: "ses_b", turns: 16, ts: Date.now() - 60_000 }));
    return !!r && r.sid === "ses_a" && r.partner === "ses_b" && r.turns === 16;
  })()
);
// 5.2 stale self-relay intent → the self shape
check(
  "stale self-relay intent recovers",
  (() => {
    const r = deadArmFromIntent(JSON.stringify({ sid: "ses_x", partner: "ses_x", turns: 8, ts: Date.now() - 60_000 }));
    return !!r && r.self === "ses_x" && r.turns === 8;
  })()
);
// 5.3 a FRESH intent is a live arm in flight — left alone, no interference
check(
  "fresh intent left alone",
  deadArmFromIntent(JSON.stringify({ sid: "ses_a", partner: "ses_b", turns: 16, ts: Date.now() - 1_000 })) === null
);
// 5.4 corrupt or absent intent → no recovery, no crash
check(
  "corrupt intent ignored",
  deadArmFromIntent("{not json") === null && deadArmFromIntent(null) === null
);
// 5.5 the FORCED error path (the no-silent-catch law): a corrupt intent
// warns through log() AND returns null — the fallback path is exercised,
// not just present.
check(
  "corrupt intent warns (no silent death)",
  logLines.some((l) => l.includes("arm intent unreadable/corrupt"))
);


// ─────────────────────────────────────────────────────────────────────────
// 6. the COMMAND PATH (the quiet-nullness the cold stranger caught: the
//    published 1.0.1 shipped rememberCommand calling ITSELF — infinite
//    recursion on every /relay command — while the suite never touched
//    the path. Two arms now guard it: a structural pin against the
//    recursive fingerprint, and a behavioral extraction of the cap.

import { readFileSync } from "node:fs";
const pluginSrc = readFileSync(new URL("./index.js", import.meta.url), "utf8");

check(
  "rememberCommand adds (no self-call recursion)",
  /function rememberCommand\(key\) \{\s*handledCommands\.add\(key\);/.test(pluginSrc)
);
check(
  "rememberCommand has no recursive self-call",
  !/function rememberCommand\(key\) \{\s*rememberCommand\(key\);/.test(pluginSrc)
);

// Behavioral: the extracted rememberCommand + cap, verbatim semantics.
const handledCommands = new Set();
const HANDLED_COMMANDS_MAX = 500;
function rememberCommand(key) {
  handledCommands.add(key);
  if (handledCommands.size > HANDLED_COMMANDS_MAX) {
    const first = handledCommands.values().next().value;
    handledCommands.delete(first);
  }
}
rememberCommand("a");
rememberCommand("b");
check("command-path: adds keys", handledCommands.has("a") && handledCommands.has("b"));
rememberCommand("a");
check("command-path: re-add is idempotent", handledCommands.size === 2);
for (let i = 0; i < 600; i++) rememberCommand(`k${i}`);
check("command-path: cap holds at 500", handledCommands.size === HANDLED_COMMANDS_MAX);

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
