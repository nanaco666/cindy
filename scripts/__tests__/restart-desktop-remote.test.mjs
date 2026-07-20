import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

// 被测脚本用 path.join / path.resolve 生成路径,分隔符随平台变(Windows 反斜杠、
// 且 path.resolve 会补盘符)。测试的合成路径也必须走同一套 path API,才能在
// macOS / Windows 上都与生产实际所见一致——硬编码 POSIX 字面量只在 *nix 成立。
const stepScript = (root, name) => path.join(root, "scripts", name);

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
	const mainRoot = path.resolve("/repo/cindy");
	const featureRoot = path.resolve("/repo/cindy-feature");
	const unrelatedRoot = path.resolve("/repo/unrelated");
	const worktrees = parseWorktreePaths([
		`worktree ${mainRoot}`,
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		`worktree ${featureRoot}`,
		"HEAD def456",
		"branch refs/heads/dash/feature",
	].join("\n"));

	assert.deepEqual(worktrees, [mainRoot, featureRoot]);
	assert.equal(isRepositoryDesktopDevProcess({
		pid: 42,
		command: `node ${path.join(featureRoot, "node_modules/@electron-forge/cli")} electron-forge start`,
	}, worktrees, 999), true);
	assert.equal(isRepositoryDesktopDevProcess({
		pid: 43,
		command: `node ${path.join(unrelatedRoot, "node_modules/@electron-forge/cli")} electron-forge start`,
	}, worktrees, 999), false);
});

test("desktop restart runner keeps the kill-before-deps order by default", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(["--wait-ready"], root);
	assert.deepEqual(steps.map((step) => step.args), [
		[stepScript(root, "restart-desktop-remote.mjs"), "--kill-only"],
		[stepScript(root, "ensure-deps.mjs")],
		[stepScript(root, "ensure-dev-runtime-assets.mjs")],
		[stepScript(root, "restart-desktop-remote.mjs"), "--wait-ready"],
	]);
});

test("preserve-running skips every kill stage and reaches the readiness start", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(
		["--wait-ready", "--", "--preserve-running"],
		root,
	);
	assert.deepEqual(steps.map((step) => step.args), [
		[stepScript(root, "ensure-deps.mjs")],
		[stepScript(root, "ensure-dev-runtime-assets.mjs")],
		[
			stepScript(root, "restart-desktop-remote.mjs"),
			"--preserve-running",
			"--wait-ready",
		],
	]);
});

test("precise replacement stays in the preserve-running pipeline", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(
		["--wait-ready", "--", "--preserve-running", "--replace-running-root=/repo/old-preview"],
		root,
	);
	assert.deepEqual(steps.map((step) => step.args), [
		[stepScript(root, "ensure-deps.mjs")],
		[stepScript(root, "ensure-dev-runtime-assets.mjs")],
		[
			stepScript(root, "restart-desktop-remote.mjs"),
			"--preserve-running",
			"--replace-running-root=/repo/old-preview",
			"--wait-ready",
		],
	]);
});

test("local restart keeps --local on both process-control stages", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(["--local", "--wait-ready"], root);
	assert.deepEqual(steps[0].args, [
		stepScript(root, "restart-desktop-remote.mjs"),
		"--local",
		"--kill-only",
	]);
	assert.deepEqual(steps.at(-1).args, [
		stepScript(root, "restart-desktop-remote.mjs"),
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
	const previewRoot = path.resolve("/repo/cindy-preview");
	const userData = path.resolve("/tmp/Cindy");
	const worktrees = parseWorktreeEntries([
		`worktree ${previewRoot}`,
		"HEAD abc123",
		"branch refs/heads/dash/preview/example",
	].join("\n"));
	const electronMain = path.join(previewRoot, "node_modules", "electron", "dist", "Electron");
	const electronHelper = path.join(previewRoot, "node_modules", "electron", "helper");
	const appPath = path.join(previewRoot, "apps", "desktop");
	const devEnv = path.join(previewRoot, "apps", "desktop", "scripts", "dev-remote-env.mjs");
	const processes = [
		{ pid: 10, ppid: 9, command: `${electronMain} .` },
		{ pid: 11, ppid: 10, command: `${electronHelper} --type=renderer --user-data-dir=${userData} --app-path=${appPath}` },
		{ pid: 9, ppid: 8, command: `node ${devEnv} electron-forge start` },
	];
	const instances = identifyDesktopProcesses(
		processes,
		worktrees,
		new Map([[userData, 10]]),
	);

	assert.deepEqual(instances, [{
		pid: 10,
		rootDir: previewRoot,
		branch: "dash/preview/example",
		state: "ready",
		ready: true,
		mode: "remote",
		passive: true,
		isolated: null,
		userDataDir: userData,
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
