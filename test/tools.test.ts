import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Profile } from "../src/catalog/config.ts";
import type { Row, SqlExecutor, SqlValue } from "../src/catalog/executor.ts";
import { confirmWrite, WriteRefused } from "../src/guard.ts";
import * as tools from "../src/tools.ts";
import { PROJECT } from "./helpers.ts";

const PROFILE: Profile = { name: "dev", server: "sql01", database: "SSISDB", auth: "ntlm", domain: "CORP", user: "op", passwordEnv: "PW", encrypt: true, trustServerCertificate: false, source: "test" };

function makeEnv(options: { cwd?: string; answers?: [RegExp, Row[]][]; approve?: boolean } = {}) {
	const calls: { sql: string; params: Record<string, SqlValue> }[] = [];
	const confirmations: string[] = [];
	const db: SqlExecutor = {
		async query(sql, params = {}) {
			calls.push({ sql, params });
			return options.answers?.find(([pattern]) => pattern.test(sql))?.[1] ?? [];
		},
		async close() {},
	};
	const env: tools.ToolEnv = {
		cwd: options.cwd ?? PROJECT,
		confirm: async (title, message) => {
			confirmations.push(`${title}\n${message}`);
			if (options.approve === false) throw new WriteRefused("The user declined this operation.");
		},
		database: async () => ({ db, profile: PROFILE }),
	};
	return { env, calls, confirmations, writes: () => calls.filter((c) => /\bEXEC\b/.test(c.sql)) };
}

function workingCopy(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ssis-tools-"));
	cpSync(PROJECT, dir, { recursive: true });
	return dir;
}

describe("write guard", () => {
	const ui = (answer: boolean) => ({ hasUI: true, allowWrite: false, confirm: async () => answer });

	it("asks when a UI exists, even if the flag is set", async () => {
		let asked = 0;
		await confirmWrite({ hasUI: true, allowWrite: true, confirm: async () => (asked++, true) }, "t", "m");
		expect(asked).toBe(1);
		await expect(confirmWrite(ui(false), "t", "m")).rejects.toThrow(/declined/);
	});

	it("refuses without a UI unless the flag is set", async () => {
		const never = async () => {
			throw new Error("must not prompt");
		};
		await expect(confirmWrite({ hasUI: false, allowWrite: false, confirm: never }, "t", "m")).rejects.toThrow(/--ssis-allow-write/);
		await expect(confirmWrite({ hasUI: false, allowWrite: true, confirm: never }, "t", "m")).resolves.toBeUndefined();
	});
});

describe("offline tools", () => {
	const { env } = makeEnv();

	it("summarises a project and a package", () => {
		expect(tools.overview(env, {})).toContain("# SSIS project Sales");
		expect(tools.packageOutline(env, { path: "LoadSales.dtsx" })).toContain("- [ForEachLoop] For each sales file");
		expect(tools.packageOutline(env, { path: "@LoadSales.dtsx" })).toContain("# Package LoadSales");
		const outline = tools.packageOutline(env, { path: "LoadSales.dtsx" });
		expect(outline).toContain('ScriptMain.cs: 6 lines (detail "full" shows the code)');
		expect(tools.packageOutline(env, { path: "LoadSales.dtsx", detail: "full" })).toContain("System.IO.File.Move(file");
	});

	it("points at the packages when given a project instead of a package", () => {
		expect(() => tools.packageOutline(env, { path: "." })).toThrow(/is a project\. Pass one of its packages: .*LoadSales\.dtsx, .*MergeSales\.dtsx/);
		expect(() => tools.packageOutline(env, { path: "Nope.dtsx" })).toThrow(/Package not found/);
	});

	it("shows data flows and explains when there are none", () => {
		const flow = tools.dataFlow(env, { path: "LoadSales.dtsx" });
		expect(flow).toContain("maps: OrderId, AmountNumeric → Amount");
		expect(flow).toContain("unmapped destination columns: LoadedAt");
		expect(tools.dataFlow(env, { path: "LoadSales.dtsx", task: "Load file" })).toContain("# Data flow Package\\For each sales file\\Load file");
		expect(tools.dataFlow(env, { path: "LoadSales.dtsx", task: "Truncate staging" })).toMatch(/is a ExecuteSQL task, not a data flow/);
		expect(() => tools.dataFlow(env, { path: "LoadSales.dtsx", task: "Ghost" })).toThrow(/Data flow tasks: Package\\For each sales file\\Load file/);
		expect(tools.dataFlow(env, { path: "MergeSales.dtsx" })).toBe("Package MergeSales has no data flow tasks.");
	});

	it("searches across the project", () => {
		const hits = tools.search(env, { query: "stg.Sales" });
		expect(hits).toMatch(/^2 match\(es\) in 2 package\(s\) searched/);
		expect(hits).toContain("LoadSales.dtsx (1)");
		expect(hits).toContain("MergeSales.dtsx (1)");
		expect(tools.search(env, { query: "zzz" })).toBe('No matches for "zzz" in 2 package(s).');
		expect(tools.search(env, { query: "fact\\w+", regex: true, path: "MergeSales.dtsx" })).toContain("Package\\Merge into fact [sql]");
		expect(() => tools.search(env, { query: "(", regex: true })).toThrow(/Invalid regular expression/);
	});

	it("validates and inventories", () => {
		expect(tools.validate(env, { path: "LoadSales.dtsx" })).toMatch(/^LoadSales: No structural problems found\.\nThese are structural checks/);
		expect(tools.migrationInventory(env, {})).toContain("# Migration inventory: project Sales");
		expect(tools.migrationInventory(env, { path: "LoadSales.dtsx" })).toContain("# Migration inventory: LoadSales");
	});
});

describe("ssis_edit", () => {
	it("writes the change and reports what happened", async () => {
		const cwd = workingCopy();
		const { env } = makeEnv({ cwd });
		const before = readFileSync(join(cwd, "LoadSales.dtsx"), "utf8");
		const out = await tools.edit(env, { path: "LoadSales.dtsx", operations: [{ op: "set_sql", target: "Truncate staging", sql: "DELETE FROM stg.Sales;" }] });
		expect(out).toMatch(/^Saved: 1 operation\(s\) on LoadSales\.dtsx \(1 line\(s\) removed, 1 added\)\./);
		expect(out).toContain("the package has not been run");
		const after = readFileSync(join(cwd, "LoadSales.dtsx"), "utf8");
		expect(after).toContain(`SQLTask:SqlStatementSource="DELETE FROM stg.Sales;"`);
		expect(after.length).toBeLessThan(before.length);
		expect(tools.packageOutline(env, { path: "LoadSales.dtsx" })).toContain("sql: DELETE FROM stg.Sales;");
	});

	it("leaves the file untouched on a dry run, a failed operation or a no-op", async () => {
		const cwd = workingCopy();
		const { env } = makeEnv({ cwd });
		const file = join(cwd, "LoadSales.dtsx");
		const before = readFileSync(file, "utf8");
		expect(await tools.edit(env, { path: "LoadSales.dtsx", dryRun: true, operations: [{ op: "add_variable", name: "X" }] })).toMatch(/^Dry run, nothing written/);
		await expect(tools.edit(env, { path: "LoadSales.dtsx", operations: [{ op: "add_variable", name: "Y" }, { op: "set_sql", target: "Ghost", sql: "x" }] })).rejects.toThrow(/Operation 2/);
		await expect(tools.edit(env, { path: "LoadSales.dtsx", operations: [{ op: "set_sql", target: "Truncate staging" }] })).rejects.toThrow(/\(set_sql\) is missing: sql/);
		await expect(tools.edit(env, { path: "LoadSales.dtsx", operations: [{ op: "explode" }] })).rejects.toThrow(/unknown op "explode"/);
		await expect(tools.edit(env, { path: "LoadSales.dtsx", operations: [] })).rejects.toThrow(/No operations/);
		expect(await tools.edit(env, { path: "LoadSales.dtsx", operations: [{ op: "set_disabled", target: "Notify failure", disabled: true }] })).toMatch(/^No change/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("uses project connections when adding a task, and refuses archives and UTF-16", async () => {
		const cwd = workingCopy();
		const { env } = makeEnv({ cwd });
		await tools.edit(env, { path: "LoadSales.dtsx", operations: [{ op: "add_execute_sql_task", name: "Stats", connection: "Warehouse", sql: "EXEC dbo.Stats", after: "Run merge package" }] });
		expect(tools.packageOutline(env, { path: "LoadSales.dtsx" })).toMatch(/- \[ExecuteSQL\] Stats\n\s+after: Run merge package \(Success\)\n\s+connection: Warehouse/);

		await expect(tools.edit(env, { path: "Sales.ispac!LoadSales.dtsx", operations: [{ op: "add_variable", name: "X" }] })).rejects.toThrow(/cannot be edited in place/);
		writeFileSync(join(cwd, "Wide.dtsx"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<a/>", "utf16le")]));
		await expect(tools.edit(env, { path: "Wide.dtsx", operations: [{ op: "add_variable", name: "X" }] })).rejects.toThrow(/UTF-16/);
	});
});

describe("catalog tools", () => {
	const PARAMS: [RegExp, Row[]] = [/FROM catalog\.object_parameters/, [{ scope: "package", parameter_name: "BatchSize", data_type: "Int32", sensitive: false }]];
	const PACKAGES: [RegExp, Row[]] = [/FROM catalog\.packages k/, [{ package: "LoadSales.dtsx" }]];
	const run = { folder: "ETL", project: "Sales", package: "LoadSales.dtsx" };

	it("reads without asking for confirmation", async () => {
		const { env, confirmations } = makeEnv({ answers: [[/FROM catalog\.folders/, [{ name: "ETL", projects: 2, environments: 1 }]]] });
		expect(await tools.catalogQuery(env, { view: "folders" })).toBe("[dev: sql01]\n- name=ETL, projects=2, environments=1");
		expect(await tools.catalogQuery(env, { view: "executions" })).toBe("[dev: sql01]\nNo executions match.");
		await expect(tools.catalogQuery(env, { view: "packages", folder: "ETL" })).rejects.toThrow(/view "packages" needs: project/);
		await expect(tools.catalogQuery(env, { view: "diagnose" })).rejects.toThrow(/needs: executionId/);
		expect(confirmations).toEqual([]);
	});

	it("confirms before starting an execution and reports the outcome", async () => {
		const { env, confirmations, writes } = makeEnv({ answers: [PARAMS, PACKAGES, [/create_execution/, [{ execution_id: 55 }]], [/SELECT e\.execution_id, e\.status/, [{ status: 7 }]]] });
		const out = await tools.catalogExecute(env, { ...run, environment: undefined, parameters: [{ name: "BatchSize", value: "10" }] });
		expect(out).toBe("Execution #55 succeeded.");
		expect(confirmations).toEqual(["Start SSIS execution?\nETL/Sales/LoadSales.dtsx\non dev: sql01/SSISDB as CORP\\op (ntlm)\nno environment, BatchSize=10"]);
		expect(writes()).toHaveLength(1);
	});

	it("diagnoses a failed run and can return without waiting", async () => {
		const failed = makeEnv({
			answers: [PARAMS, PACKAGES, [/create_execution/, [{ execution_id: 56 }]], [/SELECT e\.execution_id, e\.status/, [{ status: 4 }]], [/e\.server_name/, [{ execution_id: 56, status: 4, folder_name: "ETL", project_name: "Sales", package_name: "LoadSales.dtsx", executed_as_name: "CORP\\op" }]], [/FROM catalog\.event_messages/, [{ message_type: 120, message: "Login failed for user 'x'." }]]],
		});
		const out = await tools.catalogExecute(failed.env, run);
		expect(out).toMatch(/^Execution #56 ended with status: failed\.\n\n# Execution #56: failed/);
		expect(out).toContain("Login failed for user 'x'.");

		const detached = makeEnv({ answers: [PARAMS, PACKAGES, [/create_execution/, [{ execution_id: 57 }]]] });
		expect(await tools.catalogExecute(detached.env, { ...run, wait: false })).toMatch(/^Started execution #57 on sql01\./);
		expect(detached.calls.some((c) => /SELECT e\.execution_id, e\.status/.test(c.sql))).toBe(false);
	});

	it("changes nothing on the server when the user declines", async () => {
		const answers: [RegExp, Row[]][] = [PARAMS, PACKAGES, [/SELECT e\.execution_id, e\.status/, [{ status: 2 }]], [/FROM catalog\.environment_variables/, [{ environment: "Prod", variable: "Retries", type: "Int16" }]]];
		const { env, writes, confirmations } = makeEnv({ answers, approve: false });
		await expect(tools.catalogExecute(env, run)).rejects.toThrow(/declined/);
		await expect(tools.catalogStop(env, { executionId: 9 })).rejects.toThrow(/declined/);
		await expect(tools.catalogSetParameter(env, { folder: "ETL", project: "Sales", package: "LoadSales.dtsx", name: "BatchSize", value: "5" })).rejects.toThrow(/declined/);
		await expect(tools.catalogSetParameter(env, { folder: "ETL", environment: "Prod", name: "Retries", value: "5" })).rejects.toThrow(/declined/);
		expect(confirmations).toHaveLength(4);
		expect(writes()).toEqual([]);
	});

	it("stops only executions that are still active", async () => {
		const running = makeEnv({ answers: [[/SELECT e\.execution_id, e\.status/, [{ status: 2 }]]] });
		expect(await tools.catalogStop(running.env, { executionId: 9 })).toMatch(/^Stop requested for execution #9/);
		expect(running.writes()).toHaveLength(1);

		const done = makeEnv({ answers: [[/SELECT e\.execution_id, e\.status/, [{ status: 7 }]]] });
		expect(await tools.catalogStop(done.env, { executionId: 9 })).toBe("Execution #9 is already succeeded; nothing to stop.");
		expect(done.confirmations).toEqual([]);
		await expect(tools.catalogStop(makeEnv().env, { executionId: 9 })).rejects.toThrow(/No execution #9/);
	});

	it("sets parameters and environment variables after confirmation", async () => {
		const { env, confirmations, writes } = makeEnv({ answers: [PARAMS, [/FROM catalog\.environment_variables/, [{ environment: "Prod", variable: "Retries", type: "Int16" }]]] });
		expect(await tools.catalogSetParameter(env, { folder: "ETL", project: "Sales", package: "LoadSales.dtsx", name: "BatchSize", value: "5" })).toMatch(/^Set package parameter ETL\/Sales\/LoadSales\.dtsx: BatchSize \(Int32\) = 5\./);
		expect(await tools.catalogSetParameter(env, { folder: "ETL", environment: "Prod", name: "Retries", value: "3" })).toMatch(/^Set environment variable ETL\/Prod\/Retries \(Int16\)\./);
		expect(confirmations[1]).toBe("Change SSIS environment variable?\nETL/Prod: Retries = 3\non dev: sql01/SSISDB as CORP\\op (ntlm)");
		expect(writes()).toHaveLength(2);
		await expect(tools.catalogSetParameter(env, { folder: "ETL", name: "X", value: "1" })).rejects.toThrow(/Pass project/);
	});

	it("rejects a deploy of something that is not an .ispac before connecting", async () => {
		const { env, calls } = makeEnv();
		await expect(tools.catalogDeploy(env, { ispac: "LoadSales.dtsx", folder: "ETL" })).rejects.toThrow(/Not an \.ispac file/);
		expect(calls).toEqual([]);
	});
});
