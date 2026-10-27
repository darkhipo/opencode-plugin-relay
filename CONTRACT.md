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
