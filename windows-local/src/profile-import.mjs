// Import a real Edge/Chrome profile into the host profile so agent task spaces
// inherit the logins you already have — the Windows counterpart of ego lite's
// "migrate your Chrome data" onboarding step on macOS.
//
// How it works: Chromium encrypts cookies and saved passwords with a key held in
// <UserData>/Local State, wrapped by Windows DPAPI for the current user (and, on
// recent builds, bound to the browser executable). Copying Local State together
// with the profile's data files into a fresh user-data-dir therefore keeps them
// readable, as long as the same Windows user launches the same browser binary.
//
// The source browser must be closed: Chromium holds its SQLite files open, and
// copying them live yields torn or locked databases.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

// Everything an agent needs to land on a site already signed in. Session state
// lives in more than Cookies: many sites keep their token in localStorage or
// IndexedDB, so those stores are copied too.
const PROFILE_ENTRIES = [
  // Current Chromium keeps cookies in <Profile>/Network/; the top-level copies
  // are only present on profiles that predate that move. Both are listed so an
  // old and a new profile both import cleanly.
  "Network",
  "Cookies",
  "Cookies-journal",
  "Login Data",
  "Login Data-journal",
  "Login Data For Account",
  "Web Data",
  "Web Data-journal",
  "Preferences",
  "Secure Preferences",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "Local Extension Settings",
  "Bookmarks",
  "Favicons",
  "History",
  "Trust Tokens",
];

// Cookie database, wherever this Chromium version keeps it.
function cookiePaths(profileDir) {
  return [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")];
}

const BROWSERS = {
  edge: {
    label: "Microsoft Edge",
    userData: (env) =>
      join(env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data"),
    processNames: ["msedge"],
  },
  chrome: {
    label: "Google Chrome",
    userData: (env) =>
      join(env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
    processNames: ["chrome"],
  },
};

export function knownBrowsers() {
  return Object.keys(BROWSERS);
}

/** Source profiles available for import, newest activity first. */
export function listProfiles(browser, env = process.env) {
  const spec = BROWSERS[browser];
  if (!spec) {
    throw new Error(
      `unknown browser ${JSON.stringify(browser)}; expected one of ${knownBrowsers().join(", ")}`,
    );
  }
  const userData = spec.userData(env);
  if (!existsSync(userData)) {
    return [];
  }
  const candidates = readdirSync(userData, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
    .filter((name) => existsSync(join(userData, name, "Preferences")));
  return candidates
    .map((name) => {
      const profileDir = join(userData, name);
      const cookies = cookiePaths(profileDir).find((path) => existsSync(path));
      return {
        name,
        path: profileDir,
        hasCookies: Boolean(cookies),
        lastUsed: cookies ? statSync(cookies).mtimeMs : 0,
        displayName: readProfileName(profileDir),
      };
    })
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

function readProfileName(profileDir) {
  try {
    const prefs = JSON.parse(
      readFileSync(join(profileDir, "Preferences"), "utf8"),
    );
    return prefs?.profile?.name || null;
  } catch {
    // A profile whose Preferences are unreadable still imports fine; the
    // friendly name is only used for the picker.
    return null;
  }
}

/**
 * Whether the *user's own* copy of the source browser is running, in which case
 * its cookie database is locked and a copy may come out torn.
 *
 * The host runs the same executable (Edge is usually both), so a bare process
 * name check always says "running" once the host is up. Command lines separate
 * them: the host's process carries its own --user-data-dir, which the caller
 * passes as excludeUserDataDir.
 */
export function isBrowserRunning(browser, { excludeUserDataDir } = {}) {
  const spec = BROWSERS[browser];
  if (!spec) return false;
  for (const name of spec.processNames) {
    const lines = processCommandLines(`${name}.exe`);
    if (lines === null) {
      // Could not read command lines; fall back to the conservative check.
      if (processExists(`${name}.exe`)) return true;
      continue;
    }
    const needle = (excludeUserDataDir || "").toLowerCase();
    const foreign = lines.filter(
      (line) => !needle || !line.toLowerCase().includes(needle),
    );
    if (foreign.length > 0) return true;
  }
  return false;
}

function processCommandLines(imageName) {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | ForEach-Object { $_.CommandLine }`,
      ],
      { encoding: "utf8" },
    );
    return out.split(/\r?\n/).filter((line) => line.trim() !== "");
  } catch {
    return null;
  }
}

function processExists(imageName) {
  try {
    const out = execFileSync(
      "tasklist.exe",
      ["/FI", `IMAGENAME eq ${imageName}`, "/NH"],
      {
        encoding: "utf8",
      },
    );
    return out.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Copy the chosen source profile into the host's user-data-dir as "Default".
 * Returns a report of what was copied and what was missing.
 */
export function importProfile({
  browser,
  profile,
  targetUserDataDir,
  env = process.env,
  force = false,
}) {
  const spec = BROWSERS[browser];
  if (!spec) {
    throw new Error(`unknown browser ${JSON.stringify(browser)}`);
  }
  if (
    !force &&
    isBrowserRunning(browser, { excludeUserDataDir: targetUserDataDir })
  ) {
    throw new Error(
      `${spec.label} is running. Close it completely and retry, or pass --force to copy anyway (cookies may be incomplete).`,
    );
  }
  const userData = spec.userData(env);
  const sourceProfile = join(userData, profile);
  if (!existsSync(sourceProfile)) {
    throw new Error(`source profile not found: ${sourceProfile}`);
  }
  const localState = join(userData, "Local State");
  if (!existsSync(localState)) {
    throw new Error(
      `${spec.label} Local State not found at ${localState}; without it the copied cookies cannot be decrypted.`,
    );
  }

  const targetProfile = join(targetUserDataDir, "Default");
  mkdirSync(targetProfile, { recursive: true });

  const copied = [];
  const skipped = [];

  // Local State carries the DPAPI-wrapped encryption key; without it the copied
  // Cookies and Login Data are unreadable ciphertext.
  copyFileSync(localState, join(targetUserDataDir, "Local State"));
  copied.push("Local State");

  for (const entry of PROFILE_ENTRIES) {
    const from = join(sourceProfile, entry);
    if (!existsSync(from)) {
      skipped.push(entry);
      continue;
    }
    copyEntry(from, join(targetProfile, entry), entry, copied, skipped);
  }

  // Cookies are what actually make an agent land on a site signed in, so the
  // caller is told plainly whether that specific file made it across — a
  // partial import that misses it looks successful but logs you out.
  const cookiesImported = cookiePaths(targetProfile).some((path) =>
    existsSync(path),
  );

  return {
    browser: spec.label,
    profile,
    sourceProfile,
    targetProfile,
    copied,
    skipped,
    cookiesImported,
  };
}

// Copy one profile entry. Directories are walked file-by-file so a single
// locked database (Chromium keeps Cookies open while it runs) does not throw
// away the rest of the directory.
function copyEntry(from, to, label, copied, skipped) {
  let isDirectory = false;
  try {
    isDirectory = statSync(from).isDirectory();
  } catch (error) {
    skipped.push(`${label} (${error.code || error.message})`);
    return;
  }
  if (!isDirectory) {
    try {
      copyFileSync(from, to);
      copied.push(label);
    } catch (error) {
      skipped.push(`${label} (${error.code || error.message})`);
    }
    return;
  }
  mkdirSync(to, { recursive: true });
  let entries;
  try {
    entries = readdirSync(from, { withFileTypes: true });
  } catch (error) {
    skipped.push(`${label} (${error.code || error.message})`);
    return;
  }
  for (const child of entries) {
    copyEntry(
      join(from, child.name),
      join(to, child.name),
      `${label}/${child.name}`,
      copied,
      skipped,
    );
  }
}
