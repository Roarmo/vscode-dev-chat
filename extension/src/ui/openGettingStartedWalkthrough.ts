import * as vscode from "vscode";
import { Logger } from "../logger";

const WALKTHROUGH_OPENED_KEY = "devChat.gettingStarted.opened";
const WALKTHROUGH_ID = "devChat.gettingStarted";

export async function openGettingStartedWalkthrough(
	context: vscode.ExtensionContext,
	logger: Pick<Logger, "error">,
): Promise<void> {
	if (context.globalState.get<boolean>(WALKTHROUGH_OPENED_KEY, false)) return;

	try {
		await vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			`${context.extension.id}#${WALKTHROUGH_ID}`,
			false,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger.error(`Could not open the first-run Getting Started walkthrough: ${reason}`);
		return;
	}

	try {
		await context.globalState.update(WALKTHROUGH_OPENED_KEY, true);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger.error(`Could not save the Getting Started walkthrough state: ${reason}`);
	}
}
