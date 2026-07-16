import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import parseSpdxExpression from "spdx-expression-parse";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const noticesDir = path.join(repoRoot, "notices");
const artifactNames = [
  "desktop-win",
  "desktop-macos",
  "desktop-linux",
  "mobile-ios",
  "mobile-android",
];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("generated artifact notices are platform-scoped and disclose restricted components separately", () => {
  const windows = read("notices/desktop-win.txt");
  const macos = read("notices/desktop-macos.txt");
  const linux = read("notices/desktop-linux.txt");
  const windowsRestricted = read("notices/desktop-win-restricted.txt");
  const iosRestricted = read("notices/mobile-ios-restricted.txt");
  const androidRestricted = read("notices/mobile-android-restricted.txt");

  assert.match(windows, /@img\/sharp-win32-x64@/);
  assert.doesNotMatch(windows, /@img\/sharp-darwin-/);
  assert.match(windows, /SECTION \d+: cargo packages/);
  assert.match(windows, /Android SDK Platform-Tools/);
  assert.match(macos, /@img\/sharp-darwin-/);
  assert.doesNotMatch(macos, /Android SDK Platform-Tools/);
  assert.match(linux, /@img\/sharp-linux-x64@/);
  assert.match(windowsRestricted, /@codesandbox\/nodebox@0\.1\.8/);
  assert.match(windowsRestricted, /Sustainable Use License/);
  assert.match(iosRestricted, /No restricted or proprietary components/);
  assert.doesNotMatch(iosRestricted, /Lark SSO Android SDK AAR@3\.0\.10/);
  assert.match(androidRestricted, /Lark SSO Android SDK AAR@3\.0\.10/);
  assert.doesNotMatch(androidRestricted, /Claude Code CLI@/);
  assert.doesNotMatch(windows, /@codesandbox\/nodebox@0\.1\.8 —/);
});

test("every SPDX document is structurally consistent and has valid license expressions", () => {
  for (const artifact of artifactNames) {
    const file = path.join(noticesDir, "sbom", `${artifact}.spdx.json`);
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(document.spdxVersion, "SPDX-2.3");
    assert.equal(document.dataLicense, "CC0-1.0");
    assert.match(
      document.documentNamespace,
      new RegExp(`/spdx/${artifact}/[a-f0-9]{64}$`),
    );
    assert.ok(document.packages.length > 0);

    const packageIds = new Set();
    for (const pkg of document.packages) {
      assert.equal(pkg.filesAnalyzed, false);
      assert.doesNotThrow(
        () => parseSpdxExpression(pkg.licenseDeclared),
        pkg.name,
      );
      assert.equal(pkg.licenseDeclared, pkg.licenseConcluded);
      assert.ok(!packageIds.has(pkg.SPDXID), `duplicate SPDXID: ${pkg.SPDXID}`);
      packageIds.add(pkg.SPDXID);
    }
    assert.equal(document.relationships.length, document.packages.length);
    for (const relationship of document.relationships) {
      assert.equal(relationship.spdxElementId, "SPDXRef-DOCUMENT");
      assert.equal(relationship.relationshipType, "DESCRIBES");
      assert.ok(packageIds.has(relationship.relatedSpdxElement));
    }
  }
});

test("desktop resources include both open-source and restricted disclosures", () => {
  const desktopRestricted = read(
    "apps/desktop/resources/THIRD-PARTY-RESTRICTED.txt",
  );
  assert.match(desktopRestricted, /Claude Code CLI@/);
  assert.doesNotMatch(desktopRestricted, /Lark SSO Android SDK AAR@/);
  assert.match(
    read("apps/desktop/resources/THIRD-PARTY-NOTICES.txt"),
    /sqlite-vec/,
  );
  assert.ok(
    fs.existsSync(
      path.join(repoRoot, "apps/desktop/xdt-updater/src-tauri/Cargo.lock"),
    ),
  );
});
