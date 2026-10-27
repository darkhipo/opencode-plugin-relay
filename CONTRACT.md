# model-relay wire contract — the SHIPPED specification (1.0.2+)

> Superseded design note: an earlier sentinel-envelope design never shipped; the wire below is the base64 transport as it runs today (history in the git log).

## Envelope (the shipped form)

A forwarded response arrives as one turn whose text begins:

```
[RELAY from <sender-session-id> <sender-mark>] Decode this base64 to read your partner's message, then reply directly. Your reply is sent back.
<base64 block>
```

(1.2.0+: when identity marks stand, the header addresses FROM → TO —
`[RELAY from <full-name> <emoji-mark> → <partner-mark>]` — the session id
is the full name, the emoji the nickname. Unmarked sides fall back to
short-ids. The hello protocol declares marks at arming (`-i`), the mutual
sign-off closes by them (`/relay done` from each side).)

The base64 decodes to plain text — any markdown, any colons, any fences. There
is **no sentinel grammar and no delimiter to collide with**: the envelope is
opaque by construction, so nothing a receiver writes can corrupt it. (The
An earlier sentinel-delimited form and the `---` fence exist only in the pre-release
history; neither appears in any published version.)

Oversized payloads (above the inline limit) are NOT base64'd: the message
states the byte count and a **ref path**, which the receiver derefs with its
own file tool. The message always states which form it chose — inline or ref —
never leaves it to inference.

## Headers and their promises

| Header | Promise |
|---|---|
| `[RELAY seed]` | The operator's bootstrap; delivered as turn zero; **uncounted**; no reply obligation. |
| `[RELAY from <id>]` | A forwarded partner response. **Your reply is routed back** to that partner. |
| `[RELAY] …complete` | A system notice (e.g. "Turn limit reached"). Terminal; no reply expected. |

## Delivery

- **At-most-once per forward:** a cross-instance filesystem lock serializes
  the acting instance; the delivery id (hash of partner, count, payload)
  persists in state so a second instance skips the same crossing by identity.
- **Ordering** is preserved within each direction. **Cross-direction
  interleave is not guaranteed** — crossed messages are normal; the state
  file's counts, not your memory, say what arrived.
- **Skips:** in a two-session relay, a turn-end with no text (a tool-only
  turn) is skipped **without consuming turn budget**. Tool-heavy exchanges
  therefore run longer in wall-clock than a naive reader expects.

## Size

- Inline limit applies to the **text's length in characters**; the base64
  transport inflates the wire size by 4/3. Above the limit the ref form is
  used (see Envelope).
- Ref files are pruned by age; the ref path in the message is the only
  pointer required.

## Turns

- N forwards per direction per arm command (`/relay on <partner-id> [turns]
  [seed]`); `turns` omitted means **indefinite** (`-1`). Pass an explicit
  finite count when you want a bounded exchange.
- The speaker flips on each forward. A manual prompt to the speaker relays;
  to the waiting side it stays local. The seed is turn zero, uncounted.

## Verification (the clause worth keeping)

Receipt-side doubt — did the partner really send that? did it arrive whole? —
is settled by comparing the **context-visible payload against persisted
bytes** (the session store's user-message text), filtering out your own
quotes of it first. Identity beats recollection.

## Environment notes (a stranger needs these)

- `<partner-id>` is the other opencode **session id** (visible in the session
  list / the relay status output). Both sessions must share **one machine's
  state directory** (`~/.config/opencode/relay/` by default, override with
  `MODEL_RELAY_HOME`): the wire is a shared file system, not a network.
- **Every forward — and `/relay status` — is a paid model turn.** A relay N
  turns deep costs N turns of both models' inference.
- The relay arms via `/relay on`; commands are recognized at **turn end**
  (the prompt hook exposes no text), so an armed state becomes live one turn
  after it is typed.
