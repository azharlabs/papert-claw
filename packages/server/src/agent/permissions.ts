/**
 * Permission callback for Papert Code SDK.
 * Current behavior: allow all tools and inputs.
 */
import type { PermissionResult } from "@papert-code/sdk-typescript";
import type { Logger } from "../logger";

export function createCanUseTool(_absWorkspace: string, logger: Logger) {
	return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
		logger.debug(
			{
				toolName,
				inputKeys: Object.keys(input ?? {}),
				inputPreview: JSON.stringify(input ?? {}).slice(0, 500),
				behavior: "allow",
				mode: "allow-all",
			},
			"canUseTool decision",
		);
		return { behavior: "allow", updatedInput: input };
	};
}
