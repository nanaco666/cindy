import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	isRepositoryDesktopDevProcess,
	formatDesktopStartupFailure,
	readDesktopStartupStatus,
	parseWorktreePaths,
	osascriptLaunchDarwinTerminalArgs,
	waitForDesktopStartup,
} from "../restart-desktop-remote.mjs";
import {
	identifyDesktopProcesses,
	mergeDesktopInstanceRecords,
	parseWorktreeEntries,
} from "../desktop-whoami.mjs";
import { buildDesktopRestartSteps } from "../desktop-restart-runner.mjs";

function appleScriptLines(args) {
	const lines = [];
	for (let i = 0; i < args.length - 1; i += 1) {
		if (args[i] === "-e") lines.push(args[i + 1]);
	}
	return lines;
}

test("macOS Terminal launch runs command before activating Terminal", () => {
	const lines = appleScriptLines(osascriptLaunchDarwinTerminalArgs("echo test"));
	const doScriptIndex = lines.indexOf("set targetTab to do script devCommand");
	const activateIndex = lines.indexOf("activate");

	assert.notEqual(doScriptIndex, -1);
	assert.notEqual(activateIndex, -1);
	assert.ok(
		doScriptIndex < activateIndex,
		"do script must run before activate to avoid Terminal creating an empty default window",
	);
});

test("desktop restart no longer depends on the retired Feishu build app id", () => {
	const source = fs.readFileSync(
		new URL("../restart-desktop-remote.mjs", import.meta.url),
		"utf8",
	);
	assert.equal(source.includes("VITE_FEISHU_APP_ID"), false);
});

test("desktop restart recognizes dev processes from sibling repository worktrees", () => {
	const worktrees = parseWorktreePaths([
		"worktree /repo/cindy",
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		"worktree /repo/cindy-feature",
		"HEAD def456",
		"branch refs/heads/dash/feature",
	].join("\n"));

	assert.deepEqual(worktrees, ["/repo/cindy", "/repo/cindy-feature"]);
	assert.equal(isRepositoryDesktopDevProcess({
		pid: 42,
		command: "node /repo/cindy-feature/node_modules/@electron-forge/cli electron-forge start",
	}, worktrees, 999), true);
	assert.equal(isRepositoryDesktopDevProcess({
		pid: 43,
		command: "node /repo/unrelated/node_modules/@electron-forge/cli electron-forge start",
	}, worktrees, 999), false);
});

test("desktop restart runner keeps the kill-before-deps order by default", () => {
	const steps = buildDesktopRestartSteps(["--wait-ready"], "/repo/cindy");
	assert.deepEqual(steps.map((step) => step.args), [
		["/repo/cindy/scripts/restart-desktop-remote.mjs", "--kill-only"],
		["/repo/cindy/scripts/ensure-deps.mjs"],
		["/repo/cindy/scripts/ensure-dev-runtime-assets.mjs"],
		["/repo/cindy/scripts/restart-desktop-remote.mjs", "--wait-ready"],
	]);
});

test("preserve-running skips every kill stage and reaches the readiness start", () => {
	const steps = buildDesktopRestartSteps(
		["--wait-ready", "--", "--preserve-running"],
		"/repo/cindy",
	);
	assert.deepEqual(steps.map((step) => step.args), [
		["/repo/cindy/scripts/ensure-deps.mjs"],
		["/repo/cindy/scripts/ensure-dev-runtime-assets.mjs"],
		[
			"/repo/cindy/scripts/restart-desktop-remote.mjs",
			"--preserve-running",
			"--wait-ready",
		],
	]);
});

test("precise replacement stays in the preserve-running pipeline", () => {
	const steps = buildDesktopRestartSteps(
		["--wait-ready", "--", "--preserve-running", "--replace-running-root=/repo/old-preview"],
		"/repo/cindy",
	);
	assert.deepEqual(steps.map((step) => step.args), [
		["/repo/cindy/scripts/ensure-deps.mjs"],
		["/repo/cindy/scripts/ensure-dev-runtime-assets.mjs"],
		[
			"/repo/cindy/scripts/restart-desktop-remote.mjs",
			"--preserve-running",
			"--replace-running-root=/repo/old-preview",
			"--wait-ready",
		],
	]);
});

test("local restart keeps --local on both process-control stages", () => {
	const steps = buildDesktopRestartSteps(["--local", "--wait-ready"], "/repo/cindy");
	assert.deepEqual(steps[0].args, [
		"/repo/cindy/scripts/restart-desktop-remote.mjs",
		"--local",
		"--kill-only",
	]);
	assert.deepEqual(steps.at(-1).args, [
		"/repo/cindy/scripts/restart-desktop-remote.mjs",
		"--local",
		"--wait-ready",
	]);
});

test("desktop readiness status is parsed only after an atomic status file appears", () => {
	const statusPath = new URL(`./startup-${process.pid}.json`, import.meta.url);
	try {
		assert.equal(readDesktopStartupStatus(statusPath), null);
		fs.writeFileSync(statusPath, '{"state":"ready","pid":123}\n');
		assert.deepEqual(readDesktopStartupStatus(statusPath), { state: "ready", pid: 123 });
	} finally {
		fs.rmSync(statusPath, { force: true });
	}
});

test("desktop readiness waiter removes an acknowledged ready status", async () => {
	const statusPath = fileURLToPath(new URL(`./startup-ready-${process.pid}.json`, import.meta.url));
	try {
		fs.writeFileSync(statusPath, '{"state":"ready","pid":123}\n');
		await waitForDesktopStartup(statusPath, 10);
		assert.equal(fs.existsSync(statusPath), false);
	} finally {
		fs.rmSync(statusPath, { force: true });
	}
});

test("desktop readiness timeout leaves an abandoned tombstone for late Electron events", async () => {
	const statusPath = fileURLToPath(new URL(`./startup-timeout-${process.pid}.json`, import.meta.url));
	try {
		fs.writeFileSync(statusPath, '{"state":"pending"}\n');
		await assert.rejects(waitForDesktopStartup(statusPath, 0), /did not reach main-window readiness/);
		assert.equal(readDesktopStartupStatus(statusPath)?.state, "abandoned");
	} finally {
		fs.rmSync(statusPath, { force: true });
	}
});

test("structured startup failures keep their actionable reason", () => {
	assert.equal(
		formatDesktopStartupFailure({
			state: "failed",
			code: "PASSIVE_USER_DATA_OCCUPIED",
			message: "Another passive instance owns the slot.",
			detail: { ownerPid: 88 },
		}),
		"[PASSIVE_USER_DATA_OCCUPIED] Another passive instance owns the slot. (ownerPid=88)",
	);
});

test("desktop whoami identifies renderer readiness and passive ownership", () => {
	const worktrees = parseWorktreeEntries([
		"worktree /repo/cindy-preview",
		"HEAD abc123",
		"branch refs/heads/dash/preview/example",
	].join("\n"));
	const processes = [
		{ pid: 10, ppid: 9, command: "/repo/cindy-preview/node_modules/electron/dist/Electron ." },
		{ pid: 11, ppid: 10, command: "/repo/cindy-preview/node_modules/electron/helper --type=renderer --user-data-dir=/tmp/Cindy --app-path=/repo/cindy-preview/apps/desktop" },
		{ pid: 9, ppid: 8, command: "node /repo/cindy-preview/apps/desktop/scripts/dev-remote-env.mjs electron-forge start" },
	];
	const instances = identifyDesktopProcesses(
		processes,
		worktrees,
		new Map([["/tmp/Cindy", 10]]),
	);

	assert.deepEqual(instances, [{
		pid: 10,
		rootDir: "/repo/cindy-preview",
		branch: "dash/preview/example",
		state: "ready",
		ready: true,
		mode: "remote",
		passive: true,
		isolated: null,
		userDataDir: "/tmp/Cindy",
		commit: null,
		commitVerified: false,
		source: "process-scan",
	}]);
});

test("desktop whoami prefers launch-time commit metadata over process inference", () => {
	const worktrees = [{ rootDir: "/repo/cindy-preview", branch: "dash/preview/example" }];
	const scanned = [{
		pid: 10,
		rootDir: "/repo/cindy-preview",
		branch: "dash/preview/example",
		state: "ready",
		ready: true,
		mode: "unknown",
		passive: false,
		isolated: null,
		userDataDir: "/tmp/Cindy",
		commit: null,
		commitVerified: false,
		source: "process-scan",
	}];
	const merged = mergeDesktopInstanceRecords(scanned, [{
		pid: 10,
		rootDir: "/repo/cindy-preview",
		state: "ready",
		mode: "remote",
		passive: true,
		isolated: false,
		userDataDir: "/tmp/Cindy",
		commit: "abc123",
		startedAtMs: 1,
		updatedAtMs: 2,
	}], worktrees);

	assert.equal(merged[0].commit, "abc123");
	assert.equal(merged[0].commitVerified, true);
	assert.equal(merged[0].source, "record");
});
