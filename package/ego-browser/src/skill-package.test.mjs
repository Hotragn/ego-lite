import test from "node:test";
import assert from "node:assert/strict";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Git for Windows checks symlinks out as regular files holding the target path
// unless core.symlinks is enabled, and readlink() then fails with EINVAL. Read
// whichever form the checkout produced so the entry is verified on any clone.
async function linkTarget(path) {
  if ((await lstat(path)).isSymbolicLink()) {
    return readlink(path);
  }
  return (await readFile(path, "utf8")).trim();
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bundledSkill = fileURLToPath(
  new URL("../dist/out/ego-browser/", import.meta.url),
);

test("the bundled Skill contains only publishable project resources", async () => {
  assert.deepEqual((await readdir(bundledSkill)).sort(), [
    "SKILL.md",
    "learnings",
    "references",
    "scripts",
  ]);
  assert.equal(
    await readFile(join(bundledSkill, "SKILL.md"), "utf8"),
    await readFile(join(repoRoot, "skills/ego-browser/SKILL.md"), "utf8"),
  );
});

test("project Agent and Codex entries share the canonical Skill", async () => {
  for (const directory of [".agents", ".codex"]) {
    assert.equal(
      await linkTarget(join(repoRoot, directory, "skills/ego-browser")),
      "../../skills/ego-browser",
    );
  }
});
