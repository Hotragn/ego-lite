import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const canonicalPath = join(repoRoot, "skills/ego-browser/SKILL.md");
const translationPath = join(
  repoRoot,
  "skills/ego-browser/workbench/SKILL.zh.v2.md",
);

let translation;
try {
  translation = await readFile(translationPath, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") process.exit(0);
  throw error;
}

// Hash the LF form rather than the bytes on disk: Git for Windows checks the
// canonical Skill out as CRLF by default, which would otherwise produce a
// different digest than the one recorded on a LF checkout and fail this gate
// for a file nobody edited.
const canonical = await readFile(canonicalPath, "utf8");
const actual = createHash("sha256")
  .update(canonical.replace(/\r\n/g, "\n"), "utf8")
  .digest("hex");
const expected = translation.match(
  /<!-- source-skill-sha256: ([a-f0-9]{64}) -->/,
)?.[1];

if (expected !== actual) {
  throw new Error(
    `Local Chinese Skill is out of sync with ${canonicalPath}. ` +
      `Update the translation and set source-skill-sha256 to ${actual}.`,
  );
}
