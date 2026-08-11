# ego lite for Windows — personal build

A complete, working Windows setup of everything ego lite gives an AI agent:
the `ego-browser` command on your PATH, isolated task spaces, page snapshots,
your real logins, and the skill installed for Claude Code and Codex.

**This directory is yours, not upstream.** It lives only on the `windows-local`
branch and is not part of any pull request. Delete it whenever you want — see
[Removing it](#removing-it).

---

## What this is (and honestly is not)

The ego lite _browser app_ is closed-source and macOS-only; it is not in this
repository and cannot be compiled here. What the app actually provides to an
agent is a runtime contract — the `globalThis.ego` bridge — plus a CLI and the
skill. **That entire surface is what this build implements on Windows**, backed
by the Microsoft Edge or Google Chrome you already have.

Your agent scripts are identical to macOS. The runtime executing them
(`package/ego-browser`) is the unmodified upstream one; nothing is forked.

|                                          | macOS app           | this build                      |
| ---------------------------------------- | ------------------- | ------------------------------- |
| `ego-browser` command                    | ✅                  | ✅                              |
| Task spaces, isolated tab sets           | ✅                  | ✅                              |
| Your logins carried over                 | ✅ Chrome migration | ✅ `import-profile`             |
| Page snapshots with `@ref`               | ✅ kernel-level     | ⚠️ accessibility tree           |
| Parallel spaces                          | ✅                  | ✅ (own window each)            |
| Control handoff / hard stops             | ✅                  | ✅                              |
| Screenshots, waits, locators, downloads  | ✅                  | ✅                              |
| Spaces UI, browser chrome                | ✅                  | ❌ none                         |
| Uses your daily browser profile in place | ✅                  | ❌ separate profile (by design) |

The snapshot difference is the one that matters in practice: snapshots come from
Chromium's accessibility tree here, which is solid on ordinary DOM pages and
weaker on canvas-heavy apps and deeply nested iframes.

---

## Install

Two scopes. Pick per situation — they coexist happily.

### Project-scoped (isolated, recommended)

Everything stays inside one folder: its own browser profile, cookies, task
spaces, CDP port, and agent skill. Your PATH is not modified and nothing is
shared with other projects.

```powershell
powershell -ExecutionPolicy Bypass -File windows-local\install.ps1 -Project C:\path\to\your\project
```

Then, **from that folder**:

```powershell
.ego\bin\ego-browser.cmd task.js
```

Agents working in that folder discover the skill automatically (it is installed
to `<project>\.claude\skills` and `<project>\.codex\skills`). `.ego/` is added to
the project's `.gitignore` for you, since it holds a browser profile.

The CDP port is derived from the folder path, so each project gets a stable port
of its own and two projects never drive the same browser.

### User-wide

One install for every project: `ego-browser` on your PATH, skill in your home
directory, one shared browser profile.

```powershell
powershell -ExecutionPolicy Bypass -File windows-local\install.ps1
```

**Open a new terminal afterwards** so the PATH change applies.

### What each scope touches

|                           | project                                 | user-wide                                 |
| ------------------------- | --------------------------------------- | ----------------------------------------- |
| `ego-browser` command     | `<project>\.ego\bin\`                   | `%USERPROFILE%\.local\bin\`               |
| your PATH                 | untouched                               | one entry added                           |
| agent skill               | `<project>\.claude`, `<project>\.codex` | `~\.claude`, `~\.codex`                   |
| browser profile + cookies | `<project>\.ego\state\profile`          | `%LOCALAPPDATA%\ego-windows-host\profile` |
| task spaces               | per project                             | shared                                    |
| CDP port                  | derived per folder (9530–9999)          | 9522                                      |

Every command below takes `--project <dir>` to act on a project install instead
of the user-wide one:

```powershell
node windows-local\src\ego-lite.mjs status        --project C:\path\to\project
node windows-local\src\ego-lite.mjs import-profile --project C:\path\to\project --from edge
node windows-local\src\ego-lite.mjs stop          --project C:\path\to\project
powershell -File windows-local\uninstall.ps1      -Project C:\path\to\project
```

A project uninstall deletes only that folder's `.ego` and skill; the user-wide
install and other projects are untouched.

### Carry your logins over

This is the step that makes agents useful — without it the hosted browser is
signed out of everything.

1. **Close Edge (or Chrome) completely** — check the system tray; Chromium keeps
   the cookie database locked while any window or background process is alive.
2. Then:

```powershell
node windows-local\src\ego-lite.mjs import-profile --from edge
```

It copies cookies, saved logins, and local site storage into the hosted
browser's own profile. **Your real profile is only read, never modified.** If the
cookie database is locked, the command tells you so and fails rather than
leaving you with a profile that looks imported but is logged out.

Pick a specific profile with `--profile "Profile 1"`; list what is available:

```powershell
node windows-local\src\ego-lite.mjs profiles
```

---

## Daily use

Your agents just call `ego-browser`, exactly as the skill documents:

```powershell
ego-browser task.js
ego-browser -e "console.log(await page.snapshot())"
```

PowerShell has no heredocs, so use a **script file** (best for anything
non-trivial — no shell re-encoding, no length limit) or `-e` for one-liners.

A real task looks like this — one invocation, everything inside it:

```javascript
// task.js
const task = await taskSpaces.useOrCreate("check my orders");
await browser.openOrReuseTab("https://example.com/orders", {
  wait: true,
  timeout: 30000,
});

const rows = await page.locator("table tbody tr").allInnerTexts();
console.log(JSON.stringify({ space: task.id, rows }, null, 2));
```

```powershell
ego-browser task.js
```

Task spaces persist across invocations: calling `useOrCreate` with the same name
later reattaches to the same tabs.

### Commands

```powershell
node windows-local\src\ego-lite.mjs status          # everything at a glance
node windows-local\src\ego-lite.mjs stop            # close the browser, keep state
node windows-local\src\ego-lite.mjs reset           # forget task spaces
node windows-local\src\ego-lite.mjs reset --profile  # also wipe logins
ego-browser --doctor                                # browser + endpoint + spaces
```

### Settings

Set these before running if you want to change behavior:

| Variable                   | Effect                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `EGO_HOST_SPACE_WINDOWS=1` | each task space opens in its own window (recommended — makes parallel agents legible) |
| `EGO_HOST_HEADLESS=1`      | run the browser invisibly                                                             |
| `EGO_HOST_BROWSER_PATH`    | use a specific `msedge.exe` / `chrome.exe`                                            |
| `EGO_HOST_DEBUG_PORT`      | CDP port (default `9522`)                                                             |
| `EGO_HOST_STATE_DIR`       | where spaces and the profile live (default `%LOCALAPPDATA%\ego-windows-host`)         |

To make window-per-space permanent:

```powershell
[Environment]::SetEnvironmentVariable('EGO_HOST_SPACE_WINDOWS','1','User')
```

---

## How it fits together

```
your agent (Claude Code / Codex)
      │  ego-browser task.js
      ▼
%USERPROFILE%\.local\bin\ego-browser.cmd        <- installed shim
      ▼
package/ego-windows-host                        <- implements globalThis.ego
      │  two CDP websockets on 127.0.0.1
      ▼
package/ego-browser  (unmodified upstream runtime)
      ▼
Microsoft Edge / Google Chrome, detached, own profile
```

The browser is launched **detached** and stays running between invocations —
that is what makes task spaces and logins persist. There is no daemon to babysit;
the browser itself is the long-lived process.

State on disk:

```
%LOCALAPPDATA%\ego-windows-host\
  spaces.json     task spaces, their tabs, ownership
  profile\        the hosted browser profile (imported logins live here)
```

---

## Security notes

- The hosted browser exposes CDP on `127.0.0.1:9522`. Any process running as you
  can drive it, which is the same trust boundary as any remote-debugging setup.
  Keep the port on loopback.
- After `import-profile`, the hosted profile holds copies of your cookies and
  saved logins. `reset --profile` deletes them.
- The hosted browser never touches your daily browser profile.

## Troubleshooting

| Installer seems to hang when you pipe its output to a file or another command | It has actually finished — check the log. The first run launches the browser detached, and a capturing wrapper can hold the pipe open. Run it without redirection. |
| Symptom | Fix |
| ---------------------------------- | --------------------------------------------------------------------- |
| `ego-browser` not recognized | open a new terminal; check `status` |
| Agents are logged out | close the browser fully, re-run `import-profile` |
| `no Chromium-based browser found` | set `EGO_HOST_BROWSER_PATH` |
| Port already in use | set `EGO_HOST_DEBUG_PORT` to something free |
| Browser is in a weird state | `stop`, then run anything again |
| Snapshot is thin on a complex page | expected — use `page.screenshot()` and coordinates, or DOM `evaluate` |

## Removing it

```powershell
powershell -ExecutionPolicy Bypass -File windows-local\uninstall.ps1
```

Removes the command, the installed skill, and all host state. Then delete this
directory if you want it gone entirely. The rest of the checkout is untouched.

---

## Relationship to the upstream PRs

The pieces of this work that are generally useful were submitted upstream
separately: the host package (#228), the CLI input forms (#226), the workspace
fallback (#223), download naming (#224), the ffmpeg batch-shim error (#251), and
the screencast viewport guard (#252), plus independent verification of the
Windows toolchain PR (#148). Everything in _this_ directory — the installer,
PATH shim, profile import, and skill installation — is personal glue and is
deliberately not proposed upstream.
