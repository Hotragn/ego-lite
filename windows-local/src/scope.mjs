// Install scope resolution — kept separate from the CLI so it is pure and
// testable: no filesystem access, no process spawning, no side effects.
//
// user scope    — `ego-browser` on PATH, skills in the home directory, one
//                 shared browser profile. Convenient, but global.
// project scope — everything under <dir>/.ego, including its own browser
//                 profile and CDP port, so two projects never share cookies,
//                 task spaces, or a browser window.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The user-wide install owns 9522 (the host's default). Project installs get a
// stable port derived from their path, in a range that cannot collide with it.
export const PROJECT_PORT_BASE = 9530;
export const PROJECT_PORT_RANGE = 470;
export const USER_PORT = 9522;

export function resolveScope(args, env = process.env, cwd = process.cwd()) {
  const index = args.findIndex((arg) => arg === "--project");
  if (index < 0) {
    return userScope(env);
  }
  // `--project` with no value means "this folder".
  const candidate = args[index + 1];
  const projectDir = resolve(
    candidate && !candidate.startsWith("--") ? candidate : cwd,
  );
  return projectScope(projectDir);
}

export function userScope(env = process.env) {
  const stateDir =
    env.EGO_HOST_STATE_DIR ||
    join(
      env.LOCALAPPDATA || join(homedir(), ".local", "share"),
      "ego-windows-host",
    );
  return {
    mode: "user",
    label: "user-wide",
    stateDir,
    userDataDir: join(stateDir, "profile"),
    port: Number(env.EGO_HOST_DEBUG_PORT) || USER_PORT,
    shimDir: join(homedir(), ".local", "bin"),
    skillBase: homedir(),
    onlyExistingAgents: true,
    mutatesPath: true,
  };
}

export function projectScope(projectDir) {
  const egoDir = join(projectDir, ".ego");
  const stateDir = join(egoDir, "state");
  return {
    mode: "project",
    label: `project ${projectDir}`,
    projectDir,
    egoDir,
    stateDir,
    userDataDir: join(stateDir, "profile"),
    port: projectPort(projectDir),
    shimDir: join(egoDir, "bin"),
    skillBase: projectDir,
    onlyExistingAgents: false,
    mutatesPath: false,
  };
}

/**
 * Stable per-folder CDP port. The same folder always resolves to the same port
 * (so a project reattaches to its own browser across invocations), and the
 * range excludes the user-wide port. Case-insensitive because Windows paths are.
 */
export function projectPort(projectDir) {
  const key = projectDir.toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % PROJECT_PORT_RANGE;
  }
  return PROJECT_PORT_BASE + hash;
}

/** Remove the scope flag (and its value) before passing args to a subcommand. */
export function stripScopeFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--project") {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}
