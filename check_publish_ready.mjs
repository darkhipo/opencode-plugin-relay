#!/usr/bin/env node
// check_publish_ready.mjs — refuse a publish that cannot be reconstructed.
//
// Wired to `prepublishOnly`, so `npm publish` runs it before a single byte
// leaves the machine. It exists because of what happened here: 1.0.2 was
// published from a dirty worktree, so the registry got a version the
// repository never contained, and the `v1.0.2` tag points at a commit whose
// package.json still says 1.0.1. Three facts that were each individually true
// and together described an artifact nobody can rebuild.
//
// Three checks, one per way the artifact/source pair can drift:
//   1. CLEAN TREE   — a dirty tree means the artifact contains something no
//                     commit contains. Refuse.
//   2. TAG AT HEAD  — the version being published must be tagged at the commit
//                     being published. A tag on another commit is a label for
//                     a different tree.
//   3. DOCS/WIRE    — if the docs contain an envelope glyph the code does not
//                     contain, the npm page is describing a protocol that is
//                     not implemented (this repo shipped ⟦relay-payload⟧ in
//                     README and CONTRACT.md for three versions; index.js
//                     contains no ⟦ at all).
//
// Escape hatches are deliberately awkward to type: PUBLISH_READY_SKIP=clean
// or =tag or =docs (comma-separated) waives a specific check, so a waiver
// appears in the publish transcript instead of being invisible.
//
// Exit 0 = publish, 1 = refuse (npm aborts on either).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const skip = new Set(
  (process.env.PUBLISH_READY_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)
);
const problems = [];
const waived = [];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;
// npm sets npm_package_version for lifecycle scripts; use it when present so
// the check compares the two numbers that are actually in play.
const publishing = process.env.npm_package_version || version;

// ── 1. clean tree ────────────────────────────────────────────────────────
if (skip.has("clean")) {
  waived.push("clean");
} else {
  const dirty = git("status", "--porcelain", "--untracked-files=normal")
    .split("\n")
    .filter(Boolean);
  if (dirty.length) {
    problems.push(
      `working tree is DIRTY (${dirty.length} path${dirty.length === 1 ? "" : "s"}) — ` +
        `the artifact would contain changes no commit contains:\n      ` +
        dirty.slice(0, 12).join("\n      ") +
        (dirty.length > 12 ? `\n      … and ${dirty.length - 12} more` : "")
    );
  }
}

// ── 2. the version being published is the version in HEAD, tagged at HEAD ─
if (skip.has("tag")) {
  waived.push("tag");
} else {
  let headPkg = null;
  try {
    headPkg = JSON.parse(git("show", "HEAD:package.json"));
  } catch {
    problems.push("HEAD has no package.json — is this a git repo with a commit?");
  }

  if (headPkg && headPkg.version !== publishing) {
    const dirtyBump = pkg.version === publishing && headPkg.version !== publishing;
    problems.push(
      `version mismatch: publishing ${publishing}, but HEAD's package.json says ${headPkg.version}` +
        (dirtyBump ? " (the bump is uncommitted — this is exactly the 1.0.2 drift)" : "")
    );
  }

  const tag = `v${publishing}`;
  let tagTarget = null;
  try {
    tagTarget = git("rev-list", "-n", "1", tag);
  } catch {
    problems.push(`no tag ${tag} — a published version must be reconstructable by name`);
  }
  const head = git("rev-parse", "HEAD");
  if (tagTarget && tagTarget !== head) {
    const tagged = (() => {
      try {
        return JSON.parse(git("show", `${tag}:package.json`)).version;
      } catch {
        return "?";
      }
    })();
    problems.push(
      `tag ${tag} points at ${tagTarget.slice(0, 7)}, not HEAD (${head.slice(0, 7)}) ` +
        `— and the tree it labels declares version ${tagged}` +
        (tagged === publishing ? "" : `, not ${publishing}`) +
        `\n      Re-tag the commit you are publishing: git tag -f -a ${tag} -m "..." HEAD`
    );
  }
}

// ── 3. the docs describe the code that ships ─────────────────────────────
if (skip.has("docs")) {
  waived.push("docs");
} else {
  const code = read("index.js");
  // Glyphs that only appear in an envelope *grammar*. If a PROMISE document
  // uses one and the code uses none, that document is describing a transport
  // that does not exist.
  //
  // README.md is the promise document: it is the npm landing page, a stranger
  // reads it first, and it must not name a grammar the code lacks.
  //
  // CONTRACT.md is different: it is a design transcript, and its glyphs are
  // QUOTATIONS of a rejected proposal (a quotation is history, not a promise).
  // That is only legitimate while the transcript is labelled as one — so the
  // invariant is conditional, and loses its exemption the moment someone
  // strips the banner and turns it back into a spec.
  const GLYPHS = ["\u27e6", "\u27e7"]; // ⟦ ⟧
  const HISTORICAL_BANNER = "HISTORICAL DESIGN RECORD";

  const readme = read("README.md");
  const missing = GLYPHS.filter((g) => readme.includes(g) && !code.includes(g));
  if (missing.length) {
    problems.push(
      `README.md uses the envelope glyph ${missing.join(" ")} but index.js contains none — ` +
        `the npm page promises a wire the code does not implement.\n` +
        `      Describe the shipping transport (base64), or remove the claim.`
    );
  }

  const contract = read("CONTRACT.md");
  const contractQuotesGlyph = GLYPHS.some((g) => contract.includes(g));
  if (contractQuotesGlyph && !contract.includes(HISTORICAL_BANNER)) {
    problems.push(
      `CONTRACT.md quotes the envelope glyph without carrying the "${HISTORICAL_BANNER}" ` +
        `banner — a transcript is allowed to describe a rejected design, a spec is not.\n` +
        `      Restore the banner, or make CONTRACT.md describe the shipping transport.`
    );
  }
}

// ── verdict ──────────────────────────────────────────────────────────────
if (waived.length) {
  console.error(`check_publish_ready: WAIVED ${waived.join(", ")} (PUBLISH_READY_SKIP)`);
}

if (problems.length) {
  console.error(`\ncheck_publish_ready: REFUSING to publish ${pkg.name}@${publishing}\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  console.error(
    `  A publish you cannot reconstruct from git is a publish nobody can audit.\n` +
      `  Fix the tree, the version, or the tag — in that order.\n`
  );
  process.exit(1);
}

console.error(
  `check_publish_ready: ${pkg.name}@${publishing} — clean tree, tagged at HEAD, docs match the wire`
);
