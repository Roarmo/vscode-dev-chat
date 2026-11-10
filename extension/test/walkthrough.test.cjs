const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extensionPath = path.join(__dirname, "..");
const manifest = require(path.join(extensionPath, "package.json"));

test("the Getting Started walkthrough has local content and valid completion events", () => {
	assert.ok(manifest.activationEvents.includes("onStartupFinished"));
	const [walkthrough] = manifest.contributes.walkthroughs;
	assert.equal(walkthrough.id, "devChat.gettingStarted");
	assert.equal(walkthrough.isFeatured, true);
	assert.equal(walkthrough.steps.length, 6);

	const commandIds = new Set(manifest.contributes.commands.map(({ command }) => command));
	const settingIds = new Set(Object.keys(manifest.contributes.configuration.properties));
	const builtInCommands = new Set(["workbench.action.openSettings"]);
	for (const step of walkthrough.steps) {
		const markdownPath = path.join(extensionPath, step.media.markdown);
		assert.ok(fs.existsSync(markdownPath), `${step.media.markdown} must be bundled`);
		assert.ok(step.completionEvents.length > 0, `${step.id} must have a completion event`);

		for (const event of step.completionEvents) {
			if (event.startsWith("onCommand:")) {
				assert.ok(commandIds.has(event.slice("onCommand:".length)), `${event} must reference a contributed command`);
			} else if (event.startsWith("onSettingChanged:")) {
				assert.ok(settingIds.has(event.slice("onSettingChanged:".length)), `${event} must reference a contributed setting`);
			} else {
				assert.ok(event.startsWith("onLink:"), `${event} must be a supported completion event`);
			}
		}

		const markdown = fs.readFileSync(markdownPath, "utf8");
		assert.equal(/!\[[^\]]*\]\(https?:\/\//i.test(markdown), false, `${step.id} must not load remote images`);
		const commandLinks = Array.from(markdown.matchAll(/\]\(command:([^)]+)\)/g), (match) => match[1]);
		assert.ok(commandLinks.length > 0, `${step.id} must provide an actionable command link`);
		for (const target of commandLinks) {
			const queryIndex = target.indexOf("?");
			const command = queryIndex < 0 ? target : target.slice(0, queryIndex);
			assert.ok(commandIds.has(command) || builtInCommands.has(command), `${command} must be a contributed or built-in command`);
			if (command === "workbench.action.openSettings") {
				assert.ok(queryIndex >= 0, `${command} must identify the setting to open`);
				const settingId = JSON.parse(decodeURIComponent(target.slice(queryIndex + 1)));
				assert.ok(settingIds.has(settingId), `${settingId} must be a contributed setting`);
			}
		}

		for (const event of step.completionEvents.filter((value) => value.startsWith("onLink:"))) {
			assert.ok(markdown.includes(event.slice("onLink:".length)), `${event} must match a link in ${step.media.markdown}`);
		}
	}
});
