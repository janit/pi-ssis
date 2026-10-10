/**
 * Gate for anything that changes a live SQL Server. With a UI the user is
 * always asked; without one the operation is refused unless pi was started
 * with --ssis-allow-write.
 */
export interface GuardContext {
	hasUI: boolean;
	confirm(title: string, message: string): Promise<boolean>;
	allowWrite: boolean;
}

export class WriteRefused extends Error {}

export async function confirmWrite(ctx: GuardContext, title: string, message: string): Promise<void> {
	if (ctx.hasUI) {
		if (await ctx.confirm(title, message)) return;
		throw new WriteRefused("The user declined this operation. Do not retry it unless they ask for it again.");
	}
	if (ctx.allowWrite) return;
	throw new WriteRefused(
		"This would change the SQL Server and there is no UI to confirm it. Nothing was done. To permit server changes in non-interactive mode, start pi with --ssis-allow-write.",
	);
}
