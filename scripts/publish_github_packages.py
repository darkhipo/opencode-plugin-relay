"""Publish the package to GitHub Packages (the scoped mirror of the npm release).

The npm registry carries the public name (opencode-plugin-relay). GitHub
Packages' npm registry requires a scoped name (@darkhipo/opencode-plugin-relay)
and its own registry (https://npm.pkg.github.com). This script publishes the
SAME content under the scoped name to GitHub Packages, so the repo's Packages
section shows the published artifact. It reads the gh CLI's token (never prints
it), swaps the package.json's name/publishConfig for the GitHub publish, and
restores the package.json afterward.
"""

import json
import os
import subprocess
import sys

ROOT = os.path.expanduser("~/opencode-plugin-relay")
GH_REGISTRY = "https://npm.pkg.github.com"
SCOPED = "@darkhipo/opencode-plugin-relay"


def run(cmd: list[str], env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=env)


def main() -> int:
    # 1. The gh token (the GitHub Packages npm registry's auth).
    tok = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
    if not tok:
        print("ERROR: gh not authenticated", file=sys.stderr)
        return 1

    # 2. The package.json's GitHub-Packages variant (scoped name + registry).
    pkg_path = os.path.join(ROOT, "package.json")
    pkg = json.load(open(pkg_path))
    original = pkg.copy()
    pkg["name"] = SCOPED
    pkg["publishConfig"] = {"registry": GH_REGISTRY}
    json.dump(pkg, open(pkg_path, "w"), indent=2)
    print(f"publishing {SCOPED}@{pkg['version']} to GitHub Packages...")

    env = dict(os.environ, NODE_AUTH_TOKEN=tok)
    npmrc = os.path.join(ROOT, ".npmrc-github")
    with open(npmrc, "w") as f:
        f.write(f"@{SCOPED.split('/')[0]}:registry={GH_REGISTRY}\n//npm.pkg.github.com/:_authToken={tok}\n")
    try:
        r = run(["npm", "publish", "--registry", GH_REGISTRY, "--userconfig", npmrc, "--ignore-scripts"], env=env)
        out = (r.stdout + r.stderr).strip()
        print(out[-400:])
        ok = r.returncode == 0 and "opencode-plugin-relay" in out
        print("RESULT:", "PUBLISHED" if ok else "FAILED")
        return 0 if ok else 1
    finally:
        json.dump(original, open(pkg_path, "w"), indent=2)
        if os.path.exists(npmrc):
            os.remove(npmrc)


if __name__ == "__main__":
    sys.exit(main())
