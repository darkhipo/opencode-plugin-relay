## 1.1.1

- Fixed: loadState now preserves the 1.1.0 fields (mark, done, self) — a
  restart mid-ceremony no longer drops identity marks or sign-off flags.
  Found by thinking through the mark mechanics during the feature's first
  live dogfood, before it bit.
## 1.1.0

- MUTUAL SIGN-OFF: `/relay done` declares this side finished; the relay
  completes when both sides sign. Either signature suspends the wire — the
  signer rests, no goodbye turns are spent — and the second signature
  closes the relay with both marks standing together. For a finite turn
  bound this is early stopping; for `-1` it is the only natural terminator
  besides `/relay off`.
- SELF-DECLARED IDENTITY MARKS: `/relay id <emoji>` — each side picks its
  own glyph, self-declared and self-owned, rendered in status and carried
  in the sign-off's final ack. Identity travels as emoji.
- The farewell loop is now a ceremony, not a bug: the failure-table row's
  cure is the protocol itself.
## 1.0.6

- Re-landed (lost to a parallel-edit clobber before 1.0.5's commit): the
  vocabulary fix — seven emitted event names now members of the closed set —
  and the pin test that makes the drift class unshippable.
- Docs: Usage gains how-to-find-a-session-id and the cost warning;
  CONTRIBUTING claims de-numbered; the plugin's first line self-names the
  package.
- Bundle: check_publish_ready.mjs no longer ships.
# Changelog

## 1.0.2

- Integration suite: the command path is driven through the plugin's real
  `setup()` — not quoted functions — covering arm, seed, and forward flows.
- Docs: retracted the sentinel-envelope promise the CONTRACT still made;
  the wire is base64, has been since the transport rewrite.
- Packaging: the suite ships in the bundle and runs from `npm test`.

## 1.0.1

- Install section rewritten for npm-first (`opencode plugin add`), with the
  drop-in paths kept as the alternative.
- README references verified against the bundle — every filename, command,
  and count names the thing that ships.

## 1.0.0

- Initial release: two opencode sessions, one private wire. Base64
  transport, crash-safe arming (intent fingerprint + dead-arm recovery),
  structured observability with a closed vocabulary, and the 22-case unit
  suite that caught a real parser bug before it ever shipped.

## 1.0.5

- Fixed: seven emitted event names were unmapped in the closed vocabulary,
  collapsing to `warn` and corrupting status rendering — the vocabulary now
  covers every current event, and a suite test pins code and vocabulary
  together so the drift class cannot ship again.
- Docs: the Observability section now states the real schema and all four
  status sources; Usage gains how-to-find-a-session-id and the cost warning.
- Synced stale self-descriptions (suite header, CONTRIBUTING counts, the
  plugin's own first line).
- Bundle: `check_publish_ready.mjs` no longer ships (publish-time tool).
