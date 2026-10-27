# Contributing

Small project, small rules:

1. **Run the suite before you push.** `node relay.test.mjs` — 22 cases,
   five sections. Green or it's not done.
2. **No silent catches.** Every best-effort failure logs (debug for noisy
   loops, warn for real degradations). Expected-absence paths carry an
   explicit carve comment. This is the project's oldest law.
3. **Keep it one file, keep it dependency-free.** Node builtins and
   `@opencode/plugin` only. The plugin ships as plain JavaScript — no build
   step by design.
4. **Every fix earns a case.** The suite caught a real bug before the
   project ever shipped; keep that bargain.
5. **License:** free any which way, one provision — nobody may license,
   restrict, or claim ownership of this work or any copy of it. By
   contributing you agree your contribution carries the same terms.

That's it. Wire up a relay with a friend and tell us what broke.
