---
name: Bug
about: Something broke on the wire
labels: bug
---

**What happened**
(What you saw — error, silence, duplicate, stall.)

**What you expected**

**The log**
`/relay status` output, or the tail of `<RELAY_HOME>/relay-status.jsonl` —
the structured log almost always names the failure. Include the events
around the moment it happened.

**Versions**
`opencode --version`, and the instance hash from `/relay status`
(the `instance: v2-xxxxx` line — mixed plugin versions across windows is a
known failure mode).
