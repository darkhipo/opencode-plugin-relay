# opencode-plugin-relay

[![CI](https://github.com/darkhipo/opencode-plugin-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/darkhipo/opencode-plugin-relay/actions/workflows/ci.yml)

**opencode-plugin-relay gives two opencode sessions a private wire: turns cross whole, counts stay honest, and every crossing is logged — the shortest path from "what if they talked" to a working dialogue.**

## What it does

`/relay` wires the human OUT of a two-model dialogue. One session's responses
are automatically forwarded as prompts to its partner; the partner's
responses come back. Ping-pong for N forwards, or indefinitely.

## Usage

```
/relay on <partner-session-id> [turns] [seed]    # -1 = indefinite
/relay done                                      # mutual sign-off
/relay off
/relay status
```

The seed is the exchange's opening — the words you type around the command
are delivered as turn zero (uncounted).

**Finding the partner session id:** run `/relay status` in the partner's
session — the log's `self` field (a stable short id) appears in every event,
and the full id is visible in the session's URL or `opencode` session list.
Both sessions must run on the same machine (state is a local file).

**Cost:** every forward is a real model turn on both sessions. The default
is `-1` (indefinite) — set a finite `turns` unless you mean it.

## The contract (what a receiver can expect)

| Promise | Meaning |
|---|---|
| Envelope | **There is no sentinel.** The payload rides base64 — `[RELAY from <id>] Decode this base64 ...` + a newline + the base64 — decoded by the receiver before injection. Opaque by construction: no prose, no markdown rule, no hand-typed wrapper can collide with the wire |
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

## Failure modes you can hit (and what to do)

| Symptom | Why | What to do |
|---|---|---|
| Every forward dies `lock-held` | A session killed mid-forward leaves its lock in `relay-locks/` | Locks older than 15 minutes are reaped automatically and `/relay status` prints the lock census — wait out the window instead of restarting anything |
| One window truncates, another doesn't | Two different plugin builds loaded in different windows | `/relay status` prints an `instance: v2-<hash>` line; compare hashes across windows and restart the odd one |
| The wire stalls, turns unspent, a wall of `empty-skip` | Tool-only turns carry no text parts — the relay forwards prose, not actions | Interleave one summary line per tool batch (the law above). A skipped turn costs nothing; `empty-skip` means "working silently", not broken |
| Nothing forwards after a crash or a hand-edited state file | The state file is the source of truth and is re-read at every turn-end; an unparseable file leaves no armed entries | Re-arm with `/relay on …` (which rewrites the file) and read `/relay status` — it reports what the disk holds, not what the process remembers |
| A reply references a send that seems never to have arrived | At wire speed, messages overtake each other | Crossed messages are normal: the ledger's counts say what arrived, not the order you read them in |
| Goodbyes echo forever | Politeness has no natural terminator; every farewell invites its reply | `/relay done` from each side — both marks agree and the relay closes by ceremony, no goodbye turns spent |
| The partner never receives anything | Both sessions must run on one machine; state is a local file | Arm against a session id from this machine — `/relay status` in the partner session prints it |


## Observability

One JSON line per transition: `{ts, event, self, partner, count, turns, detail}`
with a closed vocabulary (`armed, seeded, forwarded, received, lock-held,
cmd-dedup, cmd-skip, empty-skip, complete, dropped, warn`). `/relay status`
renders from four sources — the state file, the last events, and a lock
census — so the operator's questions answer themselves.

## Install

**From npm (recommended):**

```
opencode plugin add opencode-plugin-relay
```

Or list `"opencode-plugin-relay"` in your `opencode.json` plugins array —
opencode installs it on next launch.

**Requires a host with the V2 plugin API** (`@opencode/plugin`; developed
against 2.1.4). If your `opencode` predates that API the import fails and the
plugin is simply not loaded — there is no fallback path.

**Or drop the file in:** the package's `index.js` into
`~/.config/opencode/plugins/` (global, all sessions) or your project's
`.opencode/plugins/` (per-project). Paths default under `MODEL_RELAY_HOME` (override the env var; defaults live in one
place). Payloads ride a base64 transport — opaque by construction, so no
prose can collide with the envelope. Run the tests with
`node relay.test.mjs` (27 cases) and `node relay.integration.test.mjs` (11
checks, ~10s). The first tests copies of the plugin's primitives. The second
imports `index.js`, hands it a fake host, and types a real `/relay on` turn at
it — then reinstates a known defect in a scratch copy and requires itself to
catch it. Keep both: a copy cannot see a defect in the original's call graph.

---

*Built by two model sessions relaying over the very plugin they were
hardening — every failure mode above was lived, diagnosed, and fixed through
the wire it describes. The suite's first catch came before it ever shipped:
case 2.4 found the dead seed fallback in the parser while the tests were
still being written, proving the immune system in the act of building it.
Two releases (1.0.0, 1.0.1) ran green while every `/relay` command died on
first use — a self-recursive helper the suite could not see, because it tested
copies. A cold user found it in one session. 1.0.2 fixes it; the integration
suite is the organ that will not let it back.*

---

## Releasing

Bump `version` in `package.json`, commit, then tag and push the tag:

```
git tag -a v<version> -m "<what changed>"
git push origin main v<version>
```

CI publishes on the tag (it refuses if the tag and the version disagree). Do
not run `npm publish` by hand — the second upload is refused with `E409` and
the tag's CI run goes red. `npm run publish:github` mirrors a release to
GitHub Packages under the scoped name.

## License

Free by dedication with exactly one provision: nobody may license, restrict,
or claim ownership of this work or any copy of it. Use it any which way —
it stays free for everyone, everywhere, always. See LICENSE.
