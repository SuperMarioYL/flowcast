import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- fix-package-lock-version-drift -------------------------------------------
//
// Every machine-readable version surface must agree. package-lock.json's
// embedded version (root and packages."") had read "0.1.0" for five releases
// because no release ever regenerated the lock; nothing asserted the surfaces
// agree. package.json is the source of truth; this test pins the rest to it so
// a lagging surface fails CI instead of shipping silently.

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
}

test("all version surfaces agree with package.json", () => {
  const pkg = readJson("package.json") as { version: string };
  const version = pkg.version;
  assert.match(version, /^\d+\.\d+\.\d+$/, "package.json version must be semver");

  // VERSION file (no trailing newline assumptions).
  const versionFile = readFileSync(join(root, "VERSION"), "utf8").trim();
  assert.equal(versionFile, version, "VERSION file must match package.json");

  // package-lock.json embeds the package version twice.
  const lock = readJson("package-lock.json") as {
    version: string;
    packages: { "": { version: string } };
  };
  assert.equal(
    lock.version,
    version,
    "package-lock.json root version must match package.json",
  );
  assert.equal(
    lock.packages[""]?.version,
    version,
    'package-lock.json packages."" version must match package.json',
  );

  // The site's content version carries the same release. The site schema keeps
  // a top-level content_version (v-prefixed) and, since the v0.6.0 post-ship
  // redesign, a meta.content_version (bare) — both must agree with the release.
  const site = readJson("web/site.json") as {
    content_version: string;
    meta?: { content_version?: string };
  };
  assert.equal(
    site.content_version,
    `v${version}`,
    "web/site.json content_version must match the release version",
  );
  if (site.meta?.content_version !== undefined) {
    assert.equal(
      site.meta.content_version,
      version,
      "web/site.json meta.content_version must match the release version",
    );
  }

  // The CHANGELOG documents the release.
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.ok(
    changelog.includes(`## [${version}]`),
    `CHANGELOG.md must contain a section for ${version}`,
  );
});
