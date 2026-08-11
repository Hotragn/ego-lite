// Install the ego-browser skill into every agent skills directory on this
// machine — what the macOS app does on first launch ("adds the ego-browser skill
// to every agent's skills directory").
//
// Copies rather than symlinks on purpose: Windows needs elevation or Developer
// Mode for symlinks, and a copy is what makes the skill survive independently of
// this checkout.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Agent CLIs read skills from <base>/.claude/skills and <base>/.codex/skills.
// The base is the home directory for a user-wide install, or a project
// directory for a scoped one — agents pick up project-level skills when they
// run inside that project.
const AGENT_SKILL_DIRS = [
  { agent: "Claude Code", dir: (base) => join(base, ".claude", "skills") },
  { agent: "Codex", dir: (base) => join(base, ".codex", "skills") },
];

export function skillTargets(base = homedir()) {
  return AGENT_SKILL_DIRS.map(({ agent, dir }) => ({
    agent,
    root: dir(base),
    path: join(dir(base), "ego-browser"),
  }));
}

/**
 * Copy skills/ego-browser into each agent skills directory.
 *
 * `hostCommand` is recorded in a small marker file so the installed skill states
 * plainly which command drives it here — the upstream SKILL.md text assumes the
 * macOS app provides `ego-browser`, and on Windows that command is the shim this
 * layer installs.
 */
export function installSkill({
  skillSource,
  hostCommand,
  base = homedir(),
  // A user-wide install only writes where an agent already keeps its skills; a
  // project-scoped install creates the directories, since a fresh project has
  // none yet.
  onlyExistingAgents = true,
}) {
  if (!existsSync(skillSource)) {
    throw new Error(`skill source not found: ${skillSource}`);
  }
  const results = [];
  for (const target of skillTargets(base)) {
    const agentRootExists = existsSync(target.root);
    if (onlyExistingAgents && !agentRootExists) {
      results.push({ ...target, status: "skipped (agent not installed)" });
      continue;
    }
    mkdirSync(target.root, { recursive: true });
    rmSync(target.path, { recursive: true, force: true });
    cpSync(skillSource, target.path, { recursive: true });
    writeFileSync(
      join(target.path, "WINDOWS-HOST.md"),
      windowsNote(hostCommand),
      "utf8",
    );
    results.push({ ...target, status: "installed" });
  }
  return results;
}

export function uninstallSkill(base = homedir()) {
  const results = [];
  for (const target of skillTargets(base)) {
    const existed = existsSync(target.path);
    rmSync(target.path, { recursive: true, force: true });
    results.push({ ...target, status: existed ? "removed" : "not present" });
  }
  return results;
}

function windowsNote(hostCommand) {
  return `# Running this skill on Windows

This machine has no ego lite app (it is macOS-only). The skill is driven by a
local Windows host that speaks the same runtime contract against stock Microsoft
Edge or Google Chrome.

- Command: \`${hostCommand}\`
- Heredocs do not exist in PowerShell. Use a script file or inline code:

  \`\`\`powershell
  ${hostCommand} task.js
  ${hostCommand} -e "console.log(await page.snapshot())"
  \`\`\`

- Everything else in SKILL.md applies unchanged: task spaces, \`page\`,
  \`page.locator(...)\`, \`browser\`, \`taskSpaces\`, snapshots, waits.
- \`${hostCommand} --doctor\` reports the browser, endpoint, and task spaces.

Known differences from the macOS app: snapshots come from Chromium's
accessibility tree (weaker on canvas-heavy pages and deeply nested iframes),
there is no Spaces UI, and the host uses its own browser profile — run
\`${hostCommand} import-profile\` to copy your real logins into it.
`;
}
