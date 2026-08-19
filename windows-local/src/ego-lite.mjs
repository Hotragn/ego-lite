#!/usr/bin/env node
// ego lite for Windows — personal control surface.
//
// This is the local counterpart of the macOS app's lifecycle: set up the
// environment, carry your logins across, run agent scripts, inspect and reset
// state, and tear it all down again. Browser work itself is delegated to
// package/ego-windows-host, which implements the globalThis.ego contract that
// the unmodified ego-browser runtime expects.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  importProfile,
  isBrowserRunning,
  knownBrowsers,
  listProfiles,
} from "./profile-import.mjs";
import {
  installSkill,
  skillTargets,
  uninstallSkill,
} from "./skill-install.mjs";
import { resolveScope, stripScopeFlags, userScope } from "./scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const HOST_DIR = join(REPO_ROOT, "package", "ego-windows-host");
const RUNTIME_DIR = join(REPO_ROOT, "package", "ego-browser");
const SKILL_SOURCE = join(REPO_ROOT, "skills", "ego-browser");
const HOST_ENTRY = join(HOST_DIR, "bin", "ego-windows-host.mjs");
const SHIM_NAME = "ego-browser";

const HELP = `ego lite for Windows (personal build)

Scope:
  --project [dir]   install into one folder only (default: current directory).
                    Everything lives in <dir>\\.ego: its own browser profile,
                    task spaces, CDP port, and agent skill. Your PATH and your
                    other projects are untouched.
  (no flag)         user-wide install: PATH command + skills for every project.

Usage:
  ego-lite setup                 build everything, install the ego-browser
                                 command and the agent skill, verify it works
                                 (--browser edge|chrome pins which browser to
                                  host; must match the profile you import)
  ego-lite import-profile        copy your real Edge/Chrome logins into the
                                 host profile  (--from edge|chrome --profile "Default")
  ego-lite profiles              list importable browser profiles
  ego-lite run <script.js>       run an agent script (same as ego-browser <file>)
  ego-lite run -e <code>         run inline code
  ego-lite status                browser, endpoint, task spaces, install state
  ego-lite stop                  close the hosted browser (state is preserved)
  ego-lite reset [--profile]     forget task spaces; --profile also wipes the
                                 hosted browser profile (logins included)
  ego-lite uninstall             remove the command, the skill, and all state
  ego-lite help                  this text

After a user-wide setup, these are equivalent:
  ego-browser task.js            (what your agents call)
  ego-lite run task.js

After a project setup, the command is inside the project (no PATH change):
  .ego\\bin\\ego-browser.cmd task.js
`;

function main(argv) {
  const [command, ...rawRest] = argv;
  const scope = resolveScope(rawRest);
  const rest = stripScopeFlags(rawRest);
  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return 0;
    case "setup":
      return setup(rest, scope);
    case "import-profile":
      return runImportProfile(rest, scope);
    case "profiles":
      return showProfiles();
    case "run":
      return runAgentScript(rest, scope);
    case "status":
      return status(scope);
    case "stop":
      return stop({ scope });
    case "reset":
      return reset(rest, scope);
    case "uninstall":
      return uninstall(scope);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

// ---------------------------------------------------------------- setup

function setup(args, scope) {
  const skipBuild = args.includes("--no-build");
  step(`Installing: ${scope.label}`);
  if (scope.mode === "project") {
    ok(`state and profile: ${scope.stateDir}`);
    ok(`CDP port for this folder: ${scope.port}`);
    note("Your PATH and other projects are not touched.");
  }
  step("Checking Node.js");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    fail(`Node 22+ is required (found ${process.version}).`);
    return 1;
  }
  ok(`Node ${process.version}`);

  if (!skipBuild) {
    step("Building the ego-browser runtime");
    if (!npm(["install", "--no-audit", "--no-fund"], RUNTIME_DIR)) return 1;
    if (!npm(["run", "build"], RUNTIME_DIR)) return 1;
    ok("runtime built");

    step("Building the Windows host");
    if (!npm(["install", "--no-audit", "--no-fund"], HOST_DIR)) return 1;
    if (!npm(["run", "build"], HOST_DIR)) return 1;
    ok("host built");
  }

  const browserName = flagValue(args, "--browser");
  let browserPath = null;
  if (browserName) {
    try {
      browserPath = browserExecutable(browserName);
    } catch (error) {
      fail(error.message);
      return 1;
    }
    ok(`hosting ${browserName}: ${browserPath}`);
  }

  step(`Installing the ${SHIM_NAME} command`);
  const shims = writeShims(scope, browserPath);
  ok(`wrote ${shims.join(", ")}`);
  if (scope.mutatesPath) {
    ok(ensureOnUserPath(scope.shimDir));
  } else {
    note("not added to PATH (project scope) — call it by its path");
  }

  step("Installing the agent skill");
  const installed = installSkill({
    skillSource: SKILL_SOURCE,
    hostCommand:
      scope.mode === "project" ? ".ego\\bin\\ego-browser.cmd" : SHIM_NAME,
    base: scope.skillBase,
    onlyExistingAgents: scope.onlyExistingAgents,
  });
  for (const entry of installed) {
    ok(`${entry.agent}: ${entry.status} (${entry.path})`);
  }
  if (installed.every((entry) => entry.status !== "installed")) {
    note(
      "No agent skills directory found yet. Re-run setup after installing Claude Code or Codex.",
    );
  }

  if (scope.mode === "project") {
    step("Keeping .ego out of git");
    ok(ignoreEgoDir(scope));
  }

  step("Verifying the host end to end");
  const probe = hostRun(
    [
      "-e",
      "const t = await taskSpaces.useOrCreate('ego-lite setup check');" +
        "await browser.openOrReuseTab('about:blank', { wait: false });" +
        "const info = await page.info();" +
        "console.log(JSON.stringify({ space: t.id, url: info.url }));" +
        "await taskSpaces.complete(t.id, { keep: false });",
    ],
    "pipe",
    scope,
    browserPath,
  );
  if (probe.status !== 0) {
    fail("the host could not drive the browser");
    return 1;
  }
  ok("browser, task space, and runtime all responded");

  const command =
    scope.mode === "project" ? ".ego\\bin\\ego-browser.cmd" : `${SHIM_NAME}`;
  process.stdout.write(
    [
      "",
      "Setup complete.",
      "",
      `  ${command} -e "console.log(await page.snapshot())"`,
      "",
      ...(scope.mutatesPath
        ? ["Open a NEW terminal first so the updated PATH is picked up."]
        : [
            `Run it from ${scope.projectDir} (agents working there find the skill automatically).`,
          ]),
      "Next, carry your logins over so agents start signed in:",
      "",
      `  node ${relativeCliPath(scope)} import-profile --from edge${scope.mode === "project" ? ` --project "${scope.projectDir}"` : ""}`,
      "",
    ].join("\n"),
  );
  return 0;
}

function relativeCliPath(scope) {
  return scope.mode === "project"
    ? join(HERE, "ego-lite.mjs")
    : "windows-local\\src\\ego-lite.mjs";
}

// A project install writes a browser profile and cookies into .ego; that must
// never reach a commit.
function ignoreEgoDir(scope) {
  const gitignore = join(scope.projectDir, ".gitignore");
  const entry = ".ego/";
  let current = "";
  if (existsSync(gitignore)) {
    current = readFileSync(gitignore, "utf8");
    if (
      current
        .split(/\r?\n/)
        .some((line) => line.trim() === entry || line.trim() === ".ego")
    ) {
      return `${gitignore} already ignores .ego/`;
    }
  }
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(
    gitignore,
    `${current}${prefix}\n# ego lite for Windows (local browser profile and state)\n${entry}\n`,
    "utf8",
  );
  return `added ${entry} to ${gitignore}`;
}

// Standard install roots per browser family. Built with join() so there are no
// backslash-escaping traps in the source.
const BROWSER_EXES = { edge: "msedge.exe", chrome: "chrome.exe" };
const BROWSER_VENDOR_DIR = {
  edge: ["Microsoft", "Edge", "Application"],
  chrome: ["Google", "Chrome", "Application"],
};
/** Resolve a --browser name to an installed executable. */
function browserExecutable(name) {
  const exe = BROWSER_EXES[name];
  if (!exe) {
    throw new Error(
      `unknown --browser ${JSON.stringify(name)}; expected edge or chrome`,
    );
  }
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = join(root, ...BROWSER_VENDOR_DIR[name], exe);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${name} is not installed at a standard location`);
}

function writeShims(scope, browserPath) {
  mkdirSync(scope.shimDir, { recursive: true });
  const cmdPath = join(scope.shimDir, `${SHIM_NAME}.cmd`);
  const ps1Path = join(scope.shimDir, `${SHIM_NAME}.ps1`);
  // A project shim pins its own state directory and CDP port, so the isolation
  // holds no matter which shell or agent invokes it — nothing has to remember to
  // set environment variables. "nodejs" is swallowed by the host, so the
  // documented `ego-browser nodejs ...` shape keeps working either way.
  const scoped = scope.mode === "project";
  writeFileSync(
    cmdPath,
    [
      "@echo off",
      ...(scoped
        ? [
            `set "EGO_HOST_STATE_DIR=${scope.stateDir}"`,
            `set "EGO_HOST_DEBUG_PORT=${scope.port}"`,
          ]
        : []),
      ...(browserPath ? [`set "EGO_HOST_BROWSER_PATH=${browserPath}"`] : []),
      `node "${HOST_ENTRY}" %*`,
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeFileSync(
    ps1Path,
    [
      "#!/usr/bin/env pwsh",
      ...(scoped
        ? [
            `$env:EGO_HOST_STATE_DIR = '${scope.stateDir.replace(/'/g, "''")}'`,
            `$env:EGO_HOST_DEBUG_PORT = '${scope.port}'`,
          ]
        : []),
      ...(browserPath
        ? [`$env:EGO_HOST_BROWSER_PATH = '${browserPath.replace(/'/g, "''")}'`]
        : []),
      `node "${HOST_ENTRY}" @args`,
      "",
    ].join("\r\n"),
    "utf8",
  );
  return [cmdPath, ps1Path];
}

function ensureOnUserPath(dir) {
  const current =
    execPowerShell(
      `[Environment]::GetEnvironmentVariable('Path','User')`,
    ).trim() || "";
  const entries = current.split(";").filter(Boolean);
  if (entries.some((entry) => sameDir(entry, dir))) {
    return `${dir} is already on your user PATH`;
  }
  const next = [...entries, dir].join(";");
  execPowerShell(
    `[Environment]::SetEnvironmentVariable('Path', ${psQuote(next)}, 'User')`,
  );
  return `added ${dir} to your user PATH (new terminals only)`;
}

// ---------------------------------------------------------- profile import

function showProfiles() {
  let found = false;
  for (const browser of knownBrowsers()) {
    const profiles = listProfiles(browser);
    if (!profiles.length) continue;
    found = true;
    process.stdout.write(
      `${browser}${isBrowserRunning(browser, { excludeUserDataDir: userScope().userDataDir }) ? "  (running — close it before importing)" : ""}\n`,
    );
    for (const profile of profiles) {
      const label = profile.displayName ? ` "${profile.displayName}"` : "";
      const cookies = profile.hasCookies ? "" : "  [no cookies yet]";
      process.stdout.write(`  ${profile.name}${label}${cookies}\n`);
    }
  }
  if (!found) {
    process.stdout.write("No Edge or Chrome profiles found.\n");
  }
  return 0;
}

function runImportProfile(args, scope) {
  const browser = flagValue(args, "--from") || defaultBrowser();
  if (!browser) {
    fail("no Edge or Chrome profile found to import from");
    return 1;
  }
  const profiles = listProfiles(browser);
  if (!profiles.length) {
    fail(`no ${browser} profiles found`);
    return 1;
  }
  const requested = flagValue(args, "--profile");
  const profile = requested || profiles[0].name;
  if (!profiles.some((entry) => entry.name === profile)) {
    fail(
      `profile ${JSON.stringify(profile)} not found; available: ${profiles.map((p) => p.name).join(", ")}`,
    );
    return 1;
  }

  step(`Importing ${browser} profile ${JSON.stringify(profile)}`);
  note(`into ${scope.label}: ${scope.userDataDir}`);
  note(
    "This copies cookies, saved logins, and local site storage into the hosted browser profile. Nothing in your real profile is modified.",
  );
  let report;
  try {
    report = importProfile({
      browser,
      profile,
      targetUserDataDir: scope.userDataDir,
      force: args.includes("--force"),
    });
  } catch (error) {
    fail(error.message);
    return 1;
  }
  ok(`copied ${report.copied.length} items into ${report.targetProfile}`);
  const locked = report.skipped.filter((entry) => entry.includes("("));
  if (locked.length) {
    note(
      `could not read ${locked.length} file(s): ${locked.slice(0, 4).join(", ")}${locked.length > 4 ? ", ..." : ""}`,
    );
  }
  if (!report.cookiesImported) {
    fail(
      "the cookie database did not come across, so agents will NOT be signed in.",
    );
    note(
      `Close ${report.browser} completely (check the tray) and run this again without --force.`,
    );
    return 1;
  }
  ok("cookie database imported — agents will start signed in");
  note(
    "Restart the hosted browser so it reads the imported profile:  ego-lite stop",
  );
  return 0;
}

function defaultBrowser() {
  for (const browser of knownBrowsers()) {
    if (listProfiles(browser).length) return browser;
  }
  return null;
}

// ------------------------------------------------------------------ run

function runAgentScript(args, scope) {
  if (!args.length) {
    process.stderr.write("ego-lite run needs a script file or -e <code>\n");
    return 2;
  }
  return hostRun(args, "inherit", scope).status ?? 1;
}

// --------------------------------------------------------------- status

function status(scope) {
  process.stdout.write(`ego lite for Windows — status (${scope.label})\n\n`);

  const runtimeBuilt = existsSync(join(RUNTIME_DIR, "dist", "out", "index.js"));
  const hostBuilt = existsSync(join(HOST_DIR, "dist", "src", "cli.js"));
  line("runtime build", runtimeBuilt ? "ok" : "missing — run: ego-lite setup");
  line("host build", hostBuilt ? "ok" : "missing — run: ego-lite setup");

  const shim = join(scope.shimDir, `${SHIM_NAME}.cmd`);
  line(
    `${SHIM_NAME} command`,
    existsSync(shim) ? shim : "not installed — run: ego-lite setup",
  );
  if (scope.mutatesPath) {
    line(
      "on PATH",
      which(SHIM_NAME) || "not on this shell's PATH (open a new terminal)",
    );
  } else {
    line("on PATH", "no (project scope, by design)");
  }
  line("CDP port", String(scope.port));
  line("state dir", scope.stateDir);

  for (const target of skillTargets(scope.skillBase)) {
    line(
      `skill (${target.agent})`,
      existsSync(target.path) ? target.path : "not installed",
    );
  }

  const imported = cookieDbPresent(scope.userDataDir);
  line(
    "imported logins",
    imported ? "present" : "none — run: ego-lite import-profile",
  );

  process.stdout.write("\n");
  if (hostBuilt) {
    hostRun(["--doctor"], "inherit", scope);
  }
  return 0;
}

function cookieDbPresent(userDataDir) {
  return [
    join(userDataDir, "Default", "Network", "Cookies"),
    join(userDataDir, "Default", "Cookies"),
  ].some((path) => existsSync(path));
}

// ----------------------------------------------------------------- stop

function stop({ quiet = false, scope } = {}) {
  const target = scope || resolveScope([]);
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const port=${target.port};` +
        `const gone=()=>fetch('http://127.0.0.1:'+port+'/json/version').then(()=>false).catch(()=>true);` +
        `const wait=async()=>{for(let i=0;i<40;i++){if(await gone())return true;` +
        `await new Promise(r=>setTimeout(r,250))}return false};` +
        `fetch('http://127.0.0.1:'+port+'/json/version').then(r=>r.json()).then(v=>{` +
        `const ws=new WebSocket(v.webSocketDebuggerUrl);` +
        `ws.addEventListener('open',()=>{ws.send(JSON.stringify({id:1,method:'Browser.close'}));` +
        // Wait for the endpoint to actually disappear: Windows releases the
        // profile's file handles only once the process is really gone, and
        // deleting the state directory before that fails with EPERM.
        `wait().then(ok=>process.exit(ok?0:4))})}).catch(()=>process.exit(3))`,
    ],
    { encoding: "utf8" },
  );
  if (result.status === 3) {
    if (!quiet) process.stdout.write("no hosted browser is running\n");
    return 0;
  }
  if (result.status === 4) {
    process.stderr.write(
      "the hosted browser did not shut down; close it manually and retry\n",
    );
    return 1;
  }
  if (!quiet) {
    process.stdout.write(
      "hosted browser closed; task spaces and logins are preserved\n",
    );
  }
  return 0;
}

// Windows can hold a directory briefly after the owning process exits, so a
// single rm can fail with EPERM/EBUSY even though nothing is really using it.
function removeDirWithRetry(dir, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (attempt === attempts) {
        fail(`could not delete ${dir}: ${error.code || error.message}`);
        return false;
      }
      sleepSync(250);
    }
  }
  return false;
}

function sleepSync(ms) {
  // Blocking wait without extra dependencies; used only in teardown paths.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------- reset

function reset(args, scope) {
  if (stop({ quiet: true, scope }) !== 0) return 1;
  rmSync(join(scope.stateDir, "spaces.json"), { force: true });
  process.stdout.write(`task spaces cleared (${scope.label})\n`);
  if (args.includes("--profile")) {
    if (!removeDirWithRetry(scope.userDataDir)) return 1;
    process.stdout.write(
      "hosted browser profile wiped (imported logins are gone)\n",
    );
  }
  return 0;
}

// ------------------------------------------------------------ uninstall

function uninstall(scope) {
  if (stop({ quiet: true, scope }) !== 0) return 1;
  step(`Uninstalling: ${scope.label}`);
  step("Removing the agent skill");
  for (const entry of uninstallSkill(scope.skillBase)) {
    ok(`${entry.agent}: ${entry.status}`);
  }
  step(`Removing the ${SHIM_NAME} command`);
  for (const ext of ["cmd", "ps1"]) {
    rmSync(join(scope.shimDir, `${SHIM_NAME}.${ext}`), { force: true });
  }
  ok(
    scope.mutatesPath
      ? "shims removed (the PATH entry is harmless and left in place)"
      : "shims removed",
  );
  step("Removing host state");
  if (removeDirWithRetry(scope.stateDir)) {
    ok(`deleted ${scope.stateDir}`);
  }
  if (scope.mode === "project") {
    // .ego also holds the bin directory; drop the whole thing so the project
    // returns to exactly how it was.
    if (removeDirWithRetry(scope.egoDir)) {
      ok(`deleted ${scope.egoDir}`);
    }
    note(
      "The .gitignore entry is left in place; remove it by hand if you want.",
    );
  } else {
    note(
      "This checkout is untouched. Delete the windows-local/ directory to remove the rest.",
    );
  }
  return 0;
}

// --------------------------------------------------------------- helpers

function hostRun(args, stdio = "pipe", scope = null, browserPath = null) {
  const result = spawnSync(process.execPath, [HOST_ENTRY, ...args], {
    stdio,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(scope
        ? {
            EGO_HOST_STATE_DIR: scope.stateDir,
            EGO_HOST_DEBUG_PORT: String(scope.port),
          }
        : {}),
      ...(browserPath ? { EGO_HOST_BROWSER_PATH: browserPath } : {}),
    },
  });
  if (stdio === "pipe") {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0 && result.stderr)
      process.stderr.write(result.stderr);
  }
  return result;
}

function npm(args, cwd) {
  // npm is npm.cmd on Windows, and Node refuses to launch a .cmd directly
  // (EINVAL) unless it goes through a shell. Every argument here is a literal
  // from this file, so there is nothing user-supplied to quote.
  // Passed as one command string: Node deprecates an args array combined with
  // shell:true because it concatenates without escaping.
  const result = spawnSync(`npm ${args.join(" ")}`, {
    cwd,
    stdio: "inherit",
    encoding: "utf8",
    shell: true,
  });
  if (result.error || result.status !== 0) {
    fail(
      `npm ${args.join(" ")} failed in ${cwd}${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`,
    );
    return false;
  }
  return true;
}

function which(command) {
  try {
    return execFileSync("where.exe", [command], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)[0];
  } catch {
    return null;
  }
}

function execPowerShell(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  );
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sameDir(a, b) {
  const normalize = (value) =>
    resolve(value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || ""))
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  try {
    return normalize(a) === normalize(b);
  } catch {
    return false;
  }
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function line(label, value) {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
}
function step(text) {
  process.stdout.write(`\n== ${text}\n`);
}
function ok(text) {
  process.stdout.write(`   + ${text}\n`);
}
function note(text) {
  process.stdout.write(`   . ${text}\n`);
}
function fail(text) {
  process.stderr.write(`   x ${text}\n`);
}

process.exitCode = main(process.argv.slice(2));
