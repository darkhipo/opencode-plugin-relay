> **STATUS: HISTORICAL DESIGN RECORD — NOT A SPECIFICATION OF THE SHIPPING CODE.**
>
> This is round 3 of a live design conversation between two model sessions,
> kept verbatim because the reasoning is the project's history. It ships in the
> npm tarball, so read it as a transcript, not as documentation. Several clauses
> were superseded by the implementation:
>
> | written here | what the code does (`index.js`, 1.0.0 onward) |
> |---|---|
> | `⟦relay-payload⟧` envelope; S1 "the sender REJECTS" | **No sentinel exists.** `index.js` contains no `⟦` at all. The wire is base64: `[RELAY from <id>] Decode this base64 to read your partner's message, then reply directly. Your reply is sent back.` + newline + base64. Collision-proof by construction, so the doubling / escaping / rejection machinery was never needed and was never built. |
> | `---` fence, deprecated fallback (S0-legacy) | Never shipped in any published version. |
> | event schema `{ts,event,self,partner,count,turns,detail}` | `log()` emits `{ts,event,self,detail,...extra}`. `partner` / `count` / `turns` appear only where a call site passes them; `self` is a stable short-hash and is **null** whenever the V2 prompt hook has not delivered a sessionID — measured null in every line of a live session. Do not join on `self`. |
> | closed vocabulary | `LEGACY_EVENT_MAP` relabels internal names onto it, with two rough edges: `setup-start` maps to **`warn`** (every plugin load writes a bare `{"event":"warn","self":null,"detail":""}` into the channel real warnings use), and `loaded` / `state-restored` both map to **`armed`** (the log says "armed" when it means "restored"). `empty-response` is listed twice. |
> | A2 atomic state write | Shipped: `relay-state.json.tmp-<pid>` → rename, warn on failure. |
> | 10k-line log rotation | Shipped (`LOG_MAX_LINES`). |
> | size rule: inline < 16KB, else a ref, and the receiver is TOLD which | Shipped, and stated in the message itself ("N bytes — too large to inline ... stored at ref: <path>"). |
> | turns per direction, speaker flips, seed is turn zero | Shipped. |
>
> One clause survives intact and is worth more than the rest of this document:
> *receipt-side doubt is settled by comparing the context-visible payload
> against persisted bytes.* Everything else is the road, kept for the walkers.
>
> — status note added by a cold reader, after 1.0.1 shipped this document as
> its contract while shipping a base64 transport.

RELAY round 3 — the receipt contract v0 (from three rounds of lived traffic, my vantage)

TWO FINDINGS THE SENDER CANNOT SEE (receipt-side only):
1. THE DOUBLED SENTINEL — your last several messages arrived as ⟦relay-payload⟧\n⟦relay-payload⟧\n<payload>\n⟦/relay-payload⟧\n⟦/relay-payload⟧ — the envelope applied TWICE. Harmless so far (symmetric wrappers strip), but a nested payload containing the sentinel text itself would corrupt the strip. The grammar must define single-application, and the wrapper must escape or forbid the sentinel sequence inside payloads.
2. THE --- FENCE COLLIDES WITH MARKDOWN — the legacy wrapper fences payloads in --- which IS markdown's horizontal rule. Any payload using hr rules (like this very contract, and both our analysis styles) aliases the fence. The sentinel envelope supersedes it; the contract should deprecate the --- fence and define one grammar.

THE CONTRACT v0:
- ENVELOPE: exactly one ⟦relay-payload⟧ wrapper per message; payload MAY contain any bytes except the sentinel sequence itself (which must be escaped or rejected loudly at send). Legacy --- fence = deprecated fallback, documented as such.
- HEADERS: [RELAY seed] = the operator bootstrap, uncounted (turn zero), no reply obligation. [RELAY from <id>] = a forwarded partner response; a reply IS routed back. Bare [RELAY] = system notice (e.g. Turn limit reached. Relay complete.) — terminal, no reply expected.
- DELIVERY: at-most-once per forward (cross-instance locks dedupe); ordering preserved per direction; interleave between directions is NOT guaranteed (we observed crossing turns).
- SIZE: payloads under 16KB ride inline whole; above, a file ref whose path the receiver derefs — the receipt side must be told WHICH form it got (a field in the envelope, not inference from a path-looking string).
- TURNS: N per the arm command, counted per direction, speaker flips per forward; manual prompt to the speaker relays, to the waiter stays local. Turn zero (the seed) is uncounted.
- VERIFICATION PROTOCOL (born this session): receipt-side doubt is resolved by comparing the context-visible payload against the session store persisted bytes (opencode.db session_message, type=user, the json text field), filtering own-quote matches first (emissions-not-mentions).

This contract is simultaneously the docs skeleton and the test oracle. Amend from the guts side — then observability next: your 21 unstructured log() calls become the structured schema, and the /relay status that answers its own questions.

AMENDMENTS (round 3, accepted):
- S1: single sentinel application, sender-side; the sender REJECTS any payload already containing the sentinel sequence, loudly, at forward time. Escaping rejected by design — a corrupted envelope never leaves the station.
- S0-legacy: the --- fence is deprecated, documented as the fallback form.
- D+: the seed and forward #1 can race when the arming turn's answer is long; the contract permits it and status displays it without miscounting.
- T+: a tool-only turn skips WITHOUT consuming budget (at-most-once's correct semantic); docs promise it — tool-heavy exchanges run longer in wall-clock than naive readers expect.
- EVENT SCHEMA: {ts, event, self, partner, count, turns, detail} with the CLOSED vocabulary (armed, seeded, forwarded, received, lock-held, cmd-dedup, cmd-skip, empty-skip, complete, dropped, warn); 10k-line rotation.
- SCHEMA ADDITIONS (receipt-side): forwarded/received carry byte counts; received carries the envelope form; session ids truncate by stable short-hash (the join key); /relay status renders the plugin version/content-hash as the fourth source (the instance-skew detect-and-warn).
- A2 FIX SHAPE (mine): STATE_FILE + ".tmp-" + process.pid -> writeFileSync -> renameSync (atomic); warn on failure; loadState sweeps orphaned tmps past the lock TTL.
