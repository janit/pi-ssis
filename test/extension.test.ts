import { describe, expect, it } from "vitest";
import extension from "../extensions/ssis/index.ts";
import { PROJECT } from "./helpers.ts";

interface RegisteredTool {
	name: string;
	description: string;
	parameters: { properties: Record<string, unknown>; required?: string[] };
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
	execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: { type: string; text: string }[] }>;
}

function load(flags: Record<string, unknown> = {}) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	const events = new Map<string, () => Promise<void>>();
	const registeredFlags: string[] = [];
	extension({
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, options),
		registerFlag: (name: string) => registeredFlags.push(name),
		getFlag: (name: string) => flags[name],
		on: (event: string, handler: () => Promise<void>) => events.set(event, handler),
	} as never);
	return { tools, commands, events, registeredFlags };
}

function context(overrides: Record<string, unknown> = {}) {
	const notices: string[] = [];
	return {
		notices,
		ctx: { cwd: PROJECT, hasUI: false, ui: { confirm: async () => true, notify: (m: string) => notices.push(m), setStatus: () => {}, select: async () => undefined }, ...overrides },
	};
}

describe("pi extension", () => {
	const { tools, commands, events, registeredFlags } = load();

	it("registers the tools, command, flag and shutdown hook", () => {
		expect([...tools.keys()]).toEqual([
			"ssis_overview",
			"ssis_package",
			"ssis_dataflow",
			"ssis_search",
			"ssis_validate",
			"ssis_edit",
			"ssis_migration_inventory",
			"ssisdb_query",
			"ssisdb_execute",
			"ssisdb_stop",
			"ssisdb_deploy",
			"ssisdb_set_parameter",
		]);
		expect([...commands.keys()]).toEqual(["ssis"]);
		expect(registeredFlags).toEqual(["ssis-allow-write"]);
		expect(events.has("session_shutdown")).toBe(true);
	});

	it("marks exactly the server-changing tools as destructive", () => {
		const destructive = [...tools.values()].filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
		expect(destructive).toEqual(["ssisdb_execute", "ssisdb_stop", "ssisdb_deploy", "ssisdb_set_parameter"]);
		for (const t of tools.values()) {
			if (t.name !== "ssis_edit" && !destructive.includes(t.name)) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
		}
	});

	it("documents every edit operation in the tool description", () => {
		const edit = tools.get("ssis_edit")!;
		const ops = (edit.parameters.properties.operations as { items: { properties: { op: { anyOf: { const: string }[] } } } }).items.properties.op.anyOf.map((o) => o.const);
		expect(ops.length).toBe(14);
		for (const op of ops) expect(edit.description, op).toContain(`- ${op}:`);
	});

	it("runs an offline tool through the registered entry point", async () => {
		const { ctx } = context();
		const result = await tools.get("ssis_package")!.execute("1", { path: "LoadSales.dtsx" }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("# Package LoadSales");
		await expect(tools.get("ssis_package")!.execute("1", { path: "Missing.dtsx" }, undefined, undefined, ctx)).rejects.toThrow(/Package not found/);
	});

	it("explains missing configuration instead of failing obscurely", async () => {
		const { ctx, notices } = context({ cwd: "/nonexistent-pi-ssis" });
		const home = process.env.HOME;
		process.env.HOME = "/nonexistent-pi-ssis-home";
		try {
			await expect(tools.get("ssisdb_query")!.execute("1", { view: "folders" }, undefined, undefined, ctx)).rejects.toThrow(/No SSISDB connection profiles are configured/);
			await commands.get("ssis")!.handler("", ctx);
			expect(notices[0]).toMatch(/No SSISDB connection profiles are configured/);
		} finally {
			process.env.HOME = home;
		}
		await events.get("session_shutdown")!();
	});
});
