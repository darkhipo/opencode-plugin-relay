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
