import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_PORT_BASE,
  PROJECT_PORT_RANGE,
  USER_PORT,
  projectPort,
  projectScope,
  resolveScope,
  stripScopeFlags,
  userScope,
} from "./scope.mjs";

const ENV = { LOCALAPPDATA: join("C:", "Users", "agent", "AppData", "Local") };
const PROJECT = resolve("C:", "work", "alpha");

test("no flag resolves the user-wide scope", () => {
  const scope = resolveScope([], ENV);
  assert.equal(scope.mode, "user");
  assert.equal(scope.port, USER_PORT);
  assert.equal(scope.mutatesPath, true);
  assert.equal(scope.skillBase, homedir());
  assert.equal(scope.stateDir, join(ENV.LOCALAPPDATA, "ego-windows-host"));
});

test("--project with a path resolves that folder", () => {
  const scope = resolveScope(["--project", PROJECT], ENV);
  assert.equal(scope.mode, "project");
  assert.equal(scope.projectDir, PROJECT);
  assert.equal(scope.stateDir, join(PROJECT, ".ego", "state"));
  assert.equal(scope.shimDir, join(PROJECT, ".ego", "bin"));
  assert.equal(scope.skillBase, PROJECT);
});

test("--project with no value uses the working directory", () => {
  const cwd = resolve("C:", "work", "beta");
  const scope = resolveScope(["--project"], ENV, cwd);
  assert.equal(scope.projectDir, cwd);
});

test("--project followed by another flag still means the working directory", () => {
  const cwd = resolve("C:", "work", "gamma");
  const scope = resolveScope(["--project", "--no-build"], ENV, cwd);
  assert.equal(scope.projectDir, cwd);
});

test("a project scope never touches PATH or the home directory", () => {
  const scope = projectScope(PROJECT);
  assert.equal(scope.mutatesPath, false);
  assert.equal(scope.onlyExistingAgents, false, "creates agent dirs itself");
  for (const value of [scope.stateDir, scope.shimDir, scope.skillBase]) {
    assert.ok(
      value.startsWith(PROJECT),
      `${value} must stay inside the project`,
    );
  }
});

test("the user-wide scope honors the host environment overrides", () => {
  const scope = userScope({
    ...ENV,
    EGO_HOST_STATE_DIR: resolve("D:", "ego"),
    EGO_HOST_DEBUG_PORT: "9999",
  });
  assert.equal(scope.stateDir, resolve("D:", "ego"));
  assert.equal(scope.port, 9999);
});

test("a project port is stable and case-insensitive", () => {
  assert.equal(projectPort(PROJECT), projectPort(PROJECT));
  assert.equal(projectPort(PROJECT), projectPort(PROJECT.toUpperCase()));
});

test("project ports stay in range and never collide with the user-wide port", () => {
  const samples = [
    PROJECT,
    resolve("C:", "work", "beta"),
    resolve("C:", "Users", "someone", "very", "deep", "path", "project"),
    resolve("D:", "x"),
    resolve("C:", ""),
  ];
  for (const dir of samples) {
    const port = projectPort(dir);
    assert.ok(
      port >= PROJECT_PORT_BASE &&
        port < PROJECT_PORT_BASE + PROJECT_PORT_RANGE,
      `${dir} -> ${port} out of range`,
    );
    assert.notEqual(port, USER_PORT);
  }
});

test("different folders generally get different ports", () => {
  const ports = new Set(
    ["alpha", "beta", "gamma", "delta", "epsilon"].map((name) =>
      projectPort(resolve("C:", "work", name)),
    ),
  );
  assert.ok(
    ports.size >= 4,
    `expected mostly distinct ports, got ${ports.size}`,
  );
});

test("stripScopeFlags removes the flag and its value only", () => {
  assert.deepEqual(
    stripScopeFlags(["import-profile", "--project", PROJECT, "--from", "edge"]),
    ["import-profile", "--from", "edge"],
  );
  assert.deepEqual(stripScopeFlags(["setup", "--project"]), ["setup"]);
  assert.deepEqual(stripScopeFlags(["setup", "--no-build"]), [
    "setup",
    "--no-build",
  ]);
});
