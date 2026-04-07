import type { Core } from "../../core/roadmap.ts";
import type { RoadmapConfig } from "../../types/index.ts";
import {
	type PromptRunner,
	runAdvancedConfigWizard,
} from "./advanced-config-wizard.ts";

interface ConfigureAdvancedOptions {
	promptImpl?: PromptRunner;
	cancelMessage?: string;
}

export async function configureAdvancedSettings(
	core: Core,
	{
		promptImpl,
		cancelMessage = "Aborting configuration.",
	}: ConfigureAdvancedOptions = {},
): Promise<{
	mergedConfig: RoadmapConfig;
	installClaudeAgent: boolean;
	installShellCompletions: boolean;
}> {
	const existingConfig = await core.filesystem.loadConfig();
	if (!existingConfig) {
		throw new Error(
			"No roadmap project found. Initialize one first with: roadmap init",
		);
	}

	const wizardResult = await runAdvancedConfigWizard({
		existingConfig,
		cancelMessage,
		includeClaudePrompt: true,
		promptImpl,
	});

	const mergedConfig: RoadmapConfig = {
		...existingConfig,
		...wizardResult.config,
	};
	await core.filesystem.saveConfig(mergedConfig);

	return {
		mergedConfig,
		installClaudeAgent: wizardResult.installClaudeAgent,
		installShellCompletions: wizardResult.installShellCompletions,
	};
}
