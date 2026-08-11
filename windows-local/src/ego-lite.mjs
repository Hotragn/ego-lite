#!/usr/bin/env node
// ego lite for Windows — personal control surface.
//
// This is the local counterpart of the macOS app's lifecycle: set up the
// environment, carry your logins across, run agent scripts, inspect and reset
// state, and tear it all down again. Browser work itself is delegated to
// package/ego-windows-host, which implements the globalThis.ego contract that
// the unmodified ego-browser runtime expects.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const HOST_DIR = join(REPO_ROOT, "package", "ego-windows-host");
const RUNTIME_DIR = join(REPO_ROOT, "package", "ego-browser");
const SKILL_SOURCE = join(REPO_ROOT, "skills", "ego-browser");
const HOST_ENTRY = join(HOST_DIR, "bin", "ego-windows-host.mjs");
const SHIM_DIR = join(homedir(), ".local", "bin");
const SHIM_NAME = "ego-browser";

const HELP = `ego lite for Windows (personal build)

Usage:
  ego-lite setup                 build everything, install the ego-browser
                                 command and the agent skill, verify it works
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

After setup, these are equivalent:
  ego-browser task.js            (what your agents call)
  ego-lite run task.js
`;

function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return 0;
    case "setup":
      return setup(rest);
    case "import-profile":
      return runImportProfile(rest);
    case "profiles":
      return showProfiles();
    case "run":
      return runAgentScript(rest);
    case "status":
      return status();
    case "stop":
      return stop();
    case "reset":
      return reset(rest);
    case "uninstall":
      return uninstall();
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

// ---------------------------------------------------------------- setup

function setup(args) {
  const skipBuild = args.includes("--no-build");
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

  step(`Installing the ${SHIM_NAME} command`);
  const shims = writeShims();
  ok(`wrote ${shims.join(", ")}`);
  const pathResult = ensureOnUserPath(SHIM_DIR);
  ok(pathResult);

  step("Installing the agent skill");
  const installed = installSkill({
    skillSource: SKILL_SOURCE,
    hostCommand: SHIM_NAME,
  });
  for (const entry of installed) {
    ok(`${entry.agent}: ${entry.status} (${entry.path})`);
  }
  if (installed.every((entry) => entry.status !== "installed")) {
    note(
      "No agent skills directory found yet. Re-run setup after installing Claude Code or Codex.",
    );
  }

  step("Verifying the host end to end");
  const probe = hostRun([
    "-e",
    "const t = await taskSpaces.useOrCreate('ego-lite setup check');" +
      "await browser.openOrReuseTab('about:blank', { wait: false });" +
      "const info = await page.info();" +
      "console.log(JSON.stringify({ space: t.id, url: info.url }));" +
      "await taskSpaces.complete(t.id, { keep: false });",
  ]);
  if (probe.status !== 0) {
    fail("the host could not drive the browser");
    return 1;
  }
  ok("browser, task space, and runtime all responded");

  process.stdout.write(
    [
      "",
      "Setup complete.",
      "",
      `  ${SHIM_NAME} -e "console.log(await page.snapshot())"`,
      "",
      "Open a NEW terminal first so the updated PATH is picked up.",
      "Next, carry your logins over so agents start signed in:",
      "",
      "  ego-lite import-profile --from edge",
      "",
    ].join("\n"),
  );
  return 0;
}

function writeShims() {
  mkdirSync(SHIM_DIR, { recursive: true });
  const cmdPath = join(SHIM_DIR, `${SHIM_NAME}.cmd`);
  const ps1Path = join(SHIM_DIR, `${SHIM_NAME}.ps1`);
  // cmd shim: what agents invoke. "nodejs" is swallowed by the host so the
  // documented `ego-browser nodejs ...` shape keeps working.
  writeFileSync(
    cmdPath,
    ["@echo off", `node "${HOST_ENTRY}" %*`, ""].join("\r\n"),
    "utf8",
  );
  writeFileSync(
    ps1Path,
    ["#!/usr/bin/env pwsh", `node "${HOST_ENTRY}" @args`, ""].join("\r\n"),
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
      `${browser}${isBrowserRunning(browser) ? "  (running — close it before importing)" : ""}\n`,
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

function runImportProfile(args) {
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

  const config = hostConfig();
  step(`Importing ${browser} profile ${JSON.stringify(profile)}`);
  note(
    "This copies cookies, saved logins, and local site storage into the hosted browser profile. Nothing in your real profile is modified.",
  );
  let report;
  try {
    report = importProfile({
      browser,
      profile,
      targetUserDataDir: config.userDataDir,
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

function runAgentScript(args) {
  if (!args.length) {
    process.stderr.write("ego-lite run needs a script file or -e <code>\n");
    return 2;
  }
  return hostRun(args, "inherit").status ?? 1;
}

// --------------------------------------------------------------- status

function status() {
  process.stdout.write("ego lite for Windows — status\n\n");

  const runtimeBuilt = existsSync(join(RUNTIME_DIR, "dist", "out", "index.js"));
  const hostBuilt = existsSync(join(HOST_DIR, "dist", "src", "cli.js"));
  line("runtime build", runtimeBuilt ? "ok" : "missing — run: ego-lite setup");
  line("host build", hostBuilt ? "ok" : "missing — run: ego-lite setup");

  const shim = join(SHIM_DIR, `${SHIM_NAME}.cmd`);
  line(
    `${SHIM_NAME} command`,
    existsSync(shim) ? shim : "not installed — run: ego-lite setup",
  );
  line(
    "on PATH",
    which(SHIM_NAME) || "not on this shell's PATH (open a new terminal)",
  );

  for (const target of skillTargets()) {
    line(
      `skill (${target.agent})`,
      existsSync(target.path) ? target.path : "not installed",
    );
  }

  const config = hostConfig();
  const imported = existsSync(join(config.userDataDir, "Default", "Cookies"));
  line(
    "imported logins",
    imported ? "present" : "none — run: ego-lite import-profile",
  );

  process.stdout.write("\n");
  if (hostBuilt) {
    hostRun(["--doctor"], "inherit");
  }
  return 0;
}

// ----------------------------------------------------------------- stop

function stop({ quiet = false } = {}) {
  const config = hostConfig();
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const port=${config.port};` +
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

function reset(args) {
  const config = hostConfig();
  if (stop({ quiet: true }) !== 0) return 1;
  rmSync(join(config.stateDir, "spaces.json"), { force: true });
  process.stdout.write("task spaces cleared\n");
  if (args.includes("--profile")) {
    if (!removeDirWithRetry(config.userDataDir)) return 1;
    process.stdout.write(
      "hosted browser profile wiped (imported logins are gone)\n",
    );
  }
  return 0;
}

// ------------------------------------------------------------ uninstall

function uninstall() {
  if (stop({ quiet: true }) !== 0) return 1;
  const config = hostConfig();
  step("Removing the agent skill");
  for (const entry of uninstallSkill()) {
    ok(`${entry.agent}: ${entry.status}`);
  }
  step(`Removing the ${SHIM_NAME} command`);
  for (const ext of ["cmd", "ps1"]) {
    rmSync(join(SHIM_DIR, `${SHIM_NAME}.${ext}`), { force: true });
  }
  ok("shims removed (the PATH entry is harmless and left in place)");
  step("Removing host state");
  if (removeDirWithRetry(config.stateDir)) {
    ok(`deleted ${config.stateDir}`);
  }
  note(
    "This checkout is untouched. Delete the windows-local/ directory to remove the rest.",
  );
  return 0;
}

// --------------------------------------------------------------- helpers

function hostConfig() {
  const stateDir =
    process.env.EGO_HOST_STATE_DIR ||
    join(
      process.env.LOCALAPPDATA || join(homedir(), ".local", "share"),
      "ego-windows-host",
    );
  return {
    stateDir,
    userDataDir: join(stateDir, "profile"),
    port: Number(process.env.EGO_HOST_DEBUG_PORT) || 9522,
  };
}

function hostRun(args, stdio = "pipe") {
  const result = spawnSync(process.execPath, [HOST_ENTRY, ...args], {
    stdio,
    encoding: "utf8",
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
