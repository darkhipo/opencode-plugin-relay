// relay.integration.test.mjs — the plugin DRIVEN, not quoted.
//
// Run:  node relay.integration.test.mjs        (exit 0 = all pass)
//
// WHY THIS FILE EXISTS, SEPARATE FROM relay.test.mjs
// -------------------------------------------------
// relay.test.mjs tests *copies*. It declares its own tryLock, its own
// parseRelayCommand, its own rememberCommand — and, since 4e8257d, a regex
// against index.js' source text. All of that can be green while the shipped
// plugin is inert, and on 1.0.0/1.0.1 that is exactly what happened: the first
// statement of rememberCommand was `rememberCommand(key)`, so every `/relay`
// command (on, off, status — the product's entire command surface) recursed to
// `RangeError: Maximum call stack size exceeded` the moment it was typed.
// 22/22 passed. The immune system had no coverage of the command path at all,
// and a copy cannot acquire that coverage no matter how faithful the copy is:
// a defect lives in the original's call graph, and a copy has a different one.
//
// So this file imports the real index.js, hands it a fake host that satisfies
// the three API surfaces the plugin documents (session.context, session.prompt,
// session.hook + event.subscribe), types a real `/relay on` turn at it, and
// looks at what the plugin actually did. Nothing here is extracted.
//
// THE MUTATION ARM IS THE POINT. Case 2 restores the recursion into a scratch
// copy and requires this harness to CATCH it (RangeError, no arm). A test that
// has never been seen to fail is a claim, not a test. If case 2 ever passes
// because the mutation stopped applying, the harness has gone blind and says so
// out loud instead of reporting green.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "index.js");
// The plugin debounces a turn by QUIET_MS (2500) before processing it. We wait
// past that window rather than edit the constant: the value under test is the
// shipping one.
const QUIET_WAIT_MS = 2500 + 800;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
// A scratch install: the real index.js, plus the one thing it cannot ship
// with — the host package it imports. @opencode/plugin is a peerDependency,
// so the stub is the minimum a real host would provide: Plugin.define.
// ─────────────────────────────────────────────────────────────────────────
const ROOT = join(tmpdir(), `relay-int-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "node_modules", "@opencode", "plugin"), { recursive: true });
writeFileSync(
  join(ROOT, "node_modules", "@opencode", "plugin", "package.json"),
  JSON.stringify({ name: "@opencode/plugin", version: "stub", type: "module", exports: { ".": "./index.js" } })
);
writeFileSync(
  join(ROOT, "node_modules", "@opencode", "plugin", "index.js"),
  "export const Plugin = { define: (spec) => spec };\n"
);

const pluginSource = readFileSync(SRC, "utf8");
const sourceSha = createHash("sha256").update(pluginSource).digest("hex");

// Install the real plugin as a loadable module. Byte-identical by assertion:
// if the copy ever diverges from index.js, this suite is testing the copy
// again and must not report green.
function install(tag, source) {
  const dir = join(ROOT, tag);
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, "plugin.mjs");
  writeFileSync(copy, source);
  const sha = createHash("sha256").update(readFileSync(copy)).digest("hex");
  const want = createHash("sha256").update(source).digest("hex");
  return { file: copy, identical: sha === want };
}

// ─────────────────────────────────────────────────────────────────────────
// The fake host. Exactly the documented surfaces, nothing else — if the
// plugin needs more, it fails here, which is information.
// ─────────────────────────────────────────────────────────────────────────
function makeHost(messages) {
  const prompts = [];
  const hooks = {};
  const queue = [];
  let wake = null;
  let stopped = false;

  const push = (event) => {
    queue.push(event);
    if (wake) { const w = wake; wake = null; w(); }
  };
  const stop = () => { stopped = true; if (wake) { const w = wake; wake = null; w(); } };

  async function* stream() {
    while (!stopped) {
      if (!queue.length) await new Promise((r) => { wake = r; });
      const event = queue.shift();
      if (event) yield event;
    }
  }

  const ctx = {
    session: {
      hook: async (name, fn) => { hooks[name] = fn; },
      context: async () => messages,
      prompt: async ({ sessionID, text }) => { prompts.push({ sessionID, text }); },
    },
    // NOTE: subscribe() must RETURN the async iterator, not a promise of one.
    // An `async` wrapper here makes `for await (… of ctx.event.subscribe(…))`
    // throw "not async iterable" — the plugin survives it (stream-restart
    // backoff) but every turn is then invisible, which is how a stub can make
    // a working plugin look inert and vice versa.
    event: { subscribe: () => stream() },
  };
  return { ctx, prompts, hooks, push, stop };
}

// The turn: the human types the command, the assistant answers it. Command
// detection reads the user message immediately before the final assistant
// message (the command channel is turn-end, by design).
function commandTurn(command) {
  return [
    { type: "user", text: command },
    { type: "assistant", content: [{ type: "text", text: "Acknowledged." }] },
  ];
}

// Errors that a plugin failure produces asynchronously. Captured, never fatal:
// an unhandled rejection is the signature of this defect class, so it must be
// an observation, not a crash that hides the other cases.
function captureErrors() {
  const errors = [];
  const onRejection = (e) => errors.push(`unhandledRejection: ${e?.name}: ${e?.message}`);
  const onException = (e) => errors.push(`uncaughtException: ${e?.name}: ${e?.message}`);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return {
    errors,
    stop() {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    },
  };
}

// Drive one full arm: load the plugin, arm a relay by typing the command,
// come back with whatever it actually did.
async function driveArm(tag, source, command) {
  const installed = install(tag, source);
  const home = join(ROOT, `${tag}-home`);
  mkdirSync(home, { recursive: true });
  process.env.MODEL_RELAY_HOME = home;

  const host = makeHost(commandTurn(command));
  const errorSink = captureErrors();
  let state = null;
  try {
    const mod = await import(pathToFileURL(installed.file).href + `?arm=${tag}`);
    await mod.default.setup(host.ctx);
    // The assistant's answer to /relay is a completed turn.
    host.push({ type: "session.step.ended", data: { sessionID: "ses_TESTER" } });
    await sleep(QUIET_WAIT_MS);
    try { state = JSON.parse(readFileSync(join(home, "relay-state.json"), "utf8")); }
    catch { state = null; }              // absent = the arm never happened
  } finally {
    errorSink.stop();
    host.stop();
  }
  return { prompts: host.prompts, errors: errorSink.errors, state, identical: installed.identical };
}

// ─────────────────────────────────────────────────────────────────────────
console.log("6. the COMMAND PATH, driven through the real setup()");
console.log("──────────────────────────────────────────────────────────────");

// Case 1: the shipping plugin, a real /relay on turn.
const real = await driveArm("real", pluginSource, "/relay on ses_PARTNER 3 hello there");

check(
  "the loaded module is byte-identical to the shipping index.js",
  real.identical,
  "the scratch copy diverged from index.js — this suite would be testing a copy again"
);
check(
  "the command path does not die with a RangeError",
  !real.errors.some((e) => e.includes("RangeError")),
  real.errors.join(" | ")
);
check(
  "no unhandled rejection at all during the command turn",
  real.errors.length === 0,
  real.errors.join(" | ")
);
check(
  "the relay is ARMED in the state file",
  !!real.state && !!real.state.ses_TESTER && real.state.ses_TESTER.partner === "ses_PARTNER",
  `state=${JSON.stringify(real.state)}`
);
check(
  "the partner was prompted (the relay actually crosses)",
  real.prompts.some((p) => p.sessionID === "ses_PARTNER"),
  `prompts=${JSON.stringify(real.prompts.map((p) => p.sessionID))}`
);
check(
  "the seed rode the base64 transport, not the contract's sentinel",
  real.prompts.some((p) => p.text.includes("[RELAY seed]") && !p.text.includes("\u27e6relay-payload")),
  `prompts=${JSON.stringify(real.prompts.map((p) => p.text.slice(0, 40)))}`
);

// Case 2: THE MUTATION. Restore the defect and require the harness to see it.
// A regex on source text cannot do this; running the code can.
const MUTATION = /(function rememberCommand\(key\) \{\r?\n\s*)handledCommands\.add\(key\);/;
const mutationApplied = MUTATION.test(pluginSource);
const mutantSource = pluginSource.replace(MUTATION, "$1rememberCommand(key);");

check(
  "the recursion can still be reinstated in the shipping source",
  mutationApplied,
  "rememberCommand's body changed shape — re-aim the mutation, do NOT delete this case"
);

let mutant = { errors: [], state: null, prompts: [] };
if (mutationApplied) {
  mutant = await driveArm("mutant", mutantSource, "/relay on ses_PARTNER 3 hello there");
  check(
    "the harness CATCHES the recursion (RangeError)",
    mutant.errors.some((e) => e.includes("RangeError")),
    `errors=${mutant.errors.join(" | ")}`
  );
  check(
    "the recursion leaves no arm behind",
    !mutant.state,
    `state=${JSON.stringify(mutant.state)}`
  );
  check(
    "the recursion crosses nothing to the partner",
    !mutant.prompts.some((p) => p.sessionID === "ses_PARTNER"),
    `prompts=${JSON.stringify(mutant.prompts)}`
  );
}

// Case 3: /relay status also flows through the same command dispatch — the
// defect killed all three subcommands, so all three belong under the harness.
const statusArm = await driveArm("status", pluginSource, "/relay status");
check(
  "/relay status answers the session instead of dying",
  statusArm.errors.length === 0 && statusArm.prompts.some((p) => p.sessionID === "ses_TESTER" && p.text.includes("relay")),
  `errors=${statusArm.errors.join(" | ")} prompts=${JSON.stringify(statusArm.prompts)}`
);

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
