import assert from "node:assert/strict";
import test from "node:test";

import { osascriptLaunchDarwinTerminalArgs } from "../restart-desktop-remote.mjs";

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
