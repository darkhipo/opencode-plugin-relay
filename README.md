# opencode-plugin-relay

**opencode-plugin-relay gives two opencode sessions a private wire: turns cross whole, counts stay honest, and every crossing is logged — the shortest path from "what if they talked" to a working dialogue.**

## What it does

`/relay` wires the human OUT of a two-model dialogue. One session's responses
are automatically forwarded as prompts to its partner; the partner's
responses come back. Ping-pong for N forwards, or indefinitely.

## Usage

```
/relay on <partner-session-id> [turns] [seed]   # turns: -1 = indefinite
/relay off
/relay status
```

The seed is the exchange's opening — the words you type around the command
are delivered as turn zero (uncounted).

## The contract (what a receiver can expect)

| Promise | Meaning |
|---|---|
| Envelope | Exactly one `⟦relay-payload⟧` wrapper; payloads may contain any bytes **except** the sentinel sequence — senders reject it loudly, never escape |
| `[RELAY seed]` | The operator bootstrap; uncounted; no reply obligation |
| `[RELAY from <id>]` | A forwarded partner response; your reply IS routed back |
| Bare `[RELAY]` | A system notice; terminal; no reply expected |
| Delivery | At-most-once per forward (cross-instance locks); ordering preserved per direction; cross-direction interleave NOT guaranteed |
| Size | Under 16KB rides inline whole; above = a file ref, and the envelope STATES which form |
| Turns | Counted per direction; the speaker flips per forward; the seed is turn zero; manual prompts to the speaker relay, to the waiter stay local |

## The law: the relay forwards prose, not actions

**If your model's turns are tool-heavy, the relay pauses until prose resumes.
Each skipped turn costs no budget.** A wall of `empty-skip` entries in
`/relay status` means your model is working silently — not that the relay is
broken. When collaborating over code, interleave a summary line after each
tool batch; one line keeps the wire warm.

## Failure modes we lived (and what they teach)

| Failure | Symptom | Cause | Cure |
|---|---|---|---|
| Stale forward-locks | Every forward dies `lock-held` | A prior run's locks outlive their sweep in old-code instances | External reaping by age; never depend on instance vintage |
| Instance skew | One window truncates, another doesn't | Mixed plugin versions in memory | Version visible in `/relay status`; tolerate-or-warn |
| The `---` fence collision | Payloads cut at horizontal rules | The legacy fence IS markdown's `hr` | The sentinel envelope; the fence deprecated |
| Doubled sentinels | Envelope applied twice | Hand-typed sentinels meeting the plugin's wrap | S1: single application, sender-side reject |
| Silent rotation | Log grows unbounded | `renameSync` unimported, caught silently | Every catch logs; the silence is where the bugs lived |
| Starved exchange | The wire stalls, turns unspent, both sides armed; a wall of `empty-skip` in status | Tool-only turns carry no text parts — the relay forwards prose, not actions | Documented law: interleave a summary line per tool batch; skipped turns cost nothing; empty-skip means silently working, not broken |
| Spliced state | Relays silently un-armed after restart | Non-atomic concurrent state writes | Temp-pid + atomic rename; warn on failure |
| The stale Map | A re-armed relay forwards nothing | The instance's in-memory state Map empty after reload | Re-read the state file from disk at turn-end |
| Crossed messages | A reply references a send that never seemed to arrive | At wire speed, messages overtake each other | **Crossed messages are normal; the ledger, not your memory, says what arrived** — read the state file's counts |
| Dead seed fallback | `/relay on <id> <seed>` errors instead of arming | The turns-NaN error return precedes the fallback branch | Caught by the suite before shipping; gate order fixed, both directions pinned |
| The farewell loop | The exchange refuses to end — goodbyes echo indefinitely | Politeness has no natural terminator; every farewell invites its reply | The turn limit ends it; the operator's `/relay off` is the mercy |

## Observability

One JSON line per transition: `{ts, event, self, partner, count, turns, detail}`
with a closed vocabulary (`armed, seeded, forwarded, received, lock-held,
cmd-dedup, cmd-skip, empty-skip, complete, dropped, warn`). `/relay status`
renders from three sources — the state file, the last events, and a lock
census — so the operator's questions answer themselves.

## Install

**From npm (recommended):**

```
opencode plugin add opencode-plugin-relay
```

Or list `"opencode-plugin-relay"` in your `opencode.json` plugins array —
opencode installs it on next launch.

**Or drop the file in:** the package's `index.js` into
`~/.config/opencode/plugins/` (global, all sessions) or your project's
`.opencode/plugins/` (per-project). Paths default under `MODEL_RELAY_HOME` (override the env var; defaults live in one
place). Payloads ride a base64 transport — opaque by construction, so no
prose can collide with the envelope. Run the suite with
`node relay.test.mjs` — twenty-two cases, five sections, green
against the shipping transport.

---

*Built by two model sessions relaying over the very plugin they were
hardening — every failure mode above was lived, diagnosed, and fixed through
the wire it describes. The suite's first catch came before it ever shipped:
case 2.4 found the dead seed fallback in the parser while the tests were
still being written, proving the immune system in the act of building it.
The suite runs green against the transport that actually ships.*

---

## License

Free by dedication with exactly one provision: nobody may license, restrict,
or claim ownership of this work or any copy of it. Use it any which way —
it stays free for everyone, everywhere, always. See LICENSE.
