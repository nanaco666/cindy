import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	isRepositoryDesktopDevProcess,
	readDesktopStartupStatus,
	parseWorktreePaths,
	osascriptLaunchDarwinTerminalArgs,
	waitForDesktopStartup,
} from "../restart-desktop-remote.mjs";

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
