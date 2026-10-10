import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import * as catalog from "../src/catalog/catalog.ts";
import { ConfigError, describeProfile, loadConfig, pickProfile } from "../src/catalog/config.ts";
import { connect, type Row, type SqlExecutor, type SqlValue } from "../src/catalog/executor.ts";
import { loadPackage, loadProject } from "../src/dtsx/project.ts";
import { fixture } from "./helpers.ts";

/** Answers queries by matching the SQL text, and records everything it was asked. */
class FakeDb implements SqlExecutor {
	calls: { sql: string; params: Record<string, SqlValue> }[] = [];
	constructor(private readonly answers: [RegExp, Row[] | ((params: Record<string, SqlValue>) => Row[]) | Error][]) {}
	async query(sql: string, params: Record<string, SqlValue> = {}): Promise<Row[]> {
		this.calls.push({ sql, params });
		for (const [pattern, answer] of this.answers) {
			if (!pattern.test(sql)) continue;
			if (answer instanceof Error) throw answer;
			return typeof answer === "function" ? answer(params) : answer;
		}
		return [];
	}
	async close(): Promise<void> {}
	sqlMatching(pattern: RegExp) {
		return this.calls.filter((c) => pattern.test(c.sql));
	}
}

const PARAMETERS: Row[] = [
	{ scope: "project", object_name: "Sales", parameter_name: "Environment", data_type: "String", sensitive: false, default_value: "Dev" },
	{ scope: "project", object_name: "Sales", parameter_name: "ApiKey", data_type: "String", sensitive: true, default_value: "secret", design_default_value: "secret" },
	{ scope: "package", object_name: "LoadSales.dtsx", parameter_name: "BatchSize", data_type: "Int32", sensitive: false, default_value: 100 },
	{ scope: "package", object_name: "LoadSales.dtsx", parameter_name: "FullLoad", data_type: "Boolean", sensitive: false, default_value: false },
];
const PACKAGES: Row[] = [{ package: "LoadSales.dtsx" }, { package: "MergeSales.dtsx" }];

function catalogDb(extra: ConstructorParameters<typeof FakeDb>[0] = []) {
	return new FakeDb([
		...extra,
		[/FROM catalog\.object_parameters/, PARAMETERS],
		[/FROM catalog\.packages k/, PACKAGES],
		[/create_execution/, [{ execution_id: 4711 }]],
	]);
}

describe("connection profiles", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ssis-config-"));
	const write = (name: string, content: unknown) => {
		const path = join(dir, name);
		writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
		return path;
	};

	it("merges user and project files, project winning", () => {
		const user = write("user.json", { defaultProfile: "dev", profiles: { dev: { server: "a", user: "u", passwordEnv: "PW" }, prod: { server: "p", auth: "entra" } } });
		const project = write("project.json", { profiles: { dev: { server: "b", auth: "ntlm", domain: "CORP", user: "op", passwordEnv: "PW2", port: 1444, trustServerCertificate: true } } });
		const config = loadConfig(dir, [user, project]);
		const dev = pickProfile(config, undefined, dir);
		expect(dev).toMatchObject({ name: "dev", server: "b", auth: "ntlm", database: "SSISDB", encrypt: true, trustServerCertificate: true, source: project });
		expect(describeProfile(dev)).toBe("dev: b,1444/SSISDB as CORP\\op (ntlm)");
		expect(describeProfile(pickProfile(config, "prod", dir))).toBe("prod: p/SSISDB as Entra ID");
		expect(() => pickProfile(config, "qa", dir)).toThrow(/Available: dev, prod/);
	});

	it("refuses passwords stored in the file and incomplete profiles", () => {
		expect(() => loadConfig(dir, [write("pw.json", { profiles: { x: { server: "a", user: "u", password: "hunter2" } } })])).toThrow(/contains a password/);
		expect(() => loadConfig(dir, [write("nouser.json", { profiles: { x: { server: "a" } } })])).toThrow(/needs "user" and "passwordEnv"/);
		expect(() => loadConfig(dir, [write("bad.json", "{nope")])).toThrow(ConfigError);
	});

	it("explains how to configure when nothing is set up, and asks when ambiguous", () => {
		expect(() => pickProfile(loadConfig(dir, []), undefined, dir)).toThrow(/No SSISDB connection profiles[\s\S]*passwordEnv/);
		const two = loadConfig(dir, [write("two.json", { profiles: { a: { server: "a", auth: "entra" }, b: { server: "b", auth: "entra" } } })]);
		expect(() => pickProfile(two, undefined, dir)).toThrow(/Several profiles/);
	});

	it("fails before connecting when the password variable is unset", async () => {
		const config = loadConfig(dir, [write("one.json", { profiles: { x: { server: "a", user: "u", passwordEnv: "PI_SSIS_UNSET" } } })]);
		await expect(connect(pickProfile(config, undefined, dir), {})).rejects.toThrow(/PI_SSIS_UNSET, which is not set/);
	});
});

describe("catalog reads", () => {
	it("filters executions with bound parameters and a clamped limit", async () => {
		const db = new FakeDb([]);
		await catalog.listExecutions(db, { folder: "ETL", status: "failed", sinceHours: 24, limit: 5000 });
		const call = db.calls[0]!;
		expect(call.sql).toContain("SELECT TOP (200)");
		expect(call.params).toEqual({ folder: "ETL", project: null, package: null, status: 4, since: 24 });
		expect(call.sql).not.toContain("ETL");
		await expect(catalog.listExecutions(db, { status: "exploded" })).rejects.toThrow(/Unknown status/);
	});

	it("never returns sensitive values", async () => {
		const db = catalogDb([[/FROM catalog\.environment_variables/, [{ environment: "Prod", variable: "Pwd", type: "String", sensitive: true, value: "s3cret" }]]]);
		const params = await catalog.listParameters(db, "ETL", "Sales");
		expect(params.find((p) => p.parameter_name === "ApiKey")).toMatchObject({ default_value: "<sensitive>", design_default_value: "<sensitive>" });
		expect((await catalog.listEnvironments(db)).variables[0]!.value).toBe("<sensitive>");
		expect(JSON.stringify(params)).not.toContain("secret");
	});

	it("builds a diagnosis and collapses errors repeated up the container tree", async () => {
		const start = new Date("2026-10-10T02:00:00Z");
		const error = (path: string, message: string): Row => ({ message_time: start, message_type: 120, execution_path: path, message });
		const db = new FakeDb([
			[/FROM catalog\.executions e WHERE e\.execution_id/, [{ execution_id: 9, folder_name: "ETL", project_name: "Sales", package_name: "LoadSales.dtsx", status: 4, start_time: start, end_time: new Date("2026-10-10T02:03:05Z"), executed_as_name: "CORP\\svc", server_name: "SQL01", environment_name: "Prod" }]],
			[/FROM catalog\.event_messages/, [error("\\Package\\Load file", "Cannot insert NULL into column 'OrderId'."), error("\\Package", "Cannot insert NULL into column 'OrderId'."), { ...error("\\Package\\Load file", "Task failed"), message_type: 130 }]],
			[/FROM catalog\.executable_statistics/, [{ package_name: "LoadSales.dtsx", execution_path: "\\Package\\Load file", execution_duration: 1200 }]],
			[/FROM catalog\.execution_parameter_values/, [{ scope: "package", parameter_name: "BatchSize", parameter_value: 50, sensitive: false }, { scope: "project", parameter_name: "ApiKey", parameter_value: "k", sensitive: true }]],
		]);
		const text = catalog.renderDiagnosis(await catalog.diagnose(db, 9), 9);
		expect(text).toContain("# Execution #9: failed");
		expect(text).toContain("ETL/Sales/LoadSales.dtsx on SQL01");
		expect(text).toContain("ran 3m5s, as CORP\\svc, environment Prod");
		expect(text).toContain("- \\Package\\Load file (LoadSales.dtsx, 1200 ms)");
		expect(text.match(/Cannot insert NULL/g)).toHaveLength(1);
		expect(text).toContain("[task failed]");
		expect(text).toContain("- package:BatchSize = 50");
		expect(text).toContain("- project:ApiKey = <sensitive>");
		expect(catalog.renderDiagnosis(await catalog.diagnose(new FakeDb([]), 1), 1)).toBe("No execution #1 in the catalog.");
	});

	it("renders execution lists", () => {
		const text = catalog.renderExecutions([{ execution_id: 3, status: 7, folder_name: "F", project_name: "P", package_name: "K.dtsx", start_time: new Date("2026-01-01T00:00:00Z"), end_time: new Date("2026-01-01T00:00:42Z"), executed_as_name: "me" }]);
		expect(text).toBe("- #3 succeeded  F/P/K.dtsx  started 2026-01-01 00:00:00Z (42s)  by me");
		expect(catalog.renderExecutions([])).toBe("No executions match.");
	});
});

describe("catalog writes", () => {
	it("starts an execution with typed parameters and an environment reference", async () => {
		const db = catalogDb([[/FROM catalog\.environment_references/, [{ reference_id: 12, environment_name: "Prod", reference_type: "R" }, { reference_id: 13, environment_name: "Test", reference_type: "R" }]]]);
		const id = await catalog.startExecution(db, {
			folder: "ETL",
			project: "Sales",
			package: "loadsales.dtsx",
			environment: "prod",
			loggingLevel: 3,
			parameters: [{ name: "BatchSize", value: "250" }, { name: "FullLoad", value: "true" }, { name: "Environment", value: "Prod" }],
		});
		expect(id).toBe(4711);
		const { sql, params } = db.sqlMatching(/create_execution/)[0]!;
		expect(params).toMatchObject({ folder: "ETL", project: "Sales", reference: 12, logging: 3, use32: false, p0_name: "BatchSize", p0_value: 250, p1_value: true, p2_name: "Environment", p2_value: "Prod" });
		expect(sql).toContain("@reference_id = @reference");
		expect(sql).toContain("DECLARE @v0 sql_variant = CAST(@p0_value AS int);");
		expect(sql).toContain("DECLARE @v1 sql_variant = CAST(@p1_value AS bit);");
		expect(sql).toMatch(/@object_type = 30, @parameter_name = @p0_name[\s\S]*@object_type = 20, @parameter_name = @p2_name/);
		expect(sql.indexOf("start_execution")).toBeGreaterThan(sql.indexOf("@p2_name"));
		expect(sql).not.toMatch(/250|Prod/);
	});

	it("checks package, parameter and environment names before touching the server", async () => {
		const base = { folder: "ETL", project: "Sales", package: "LoadSales.dtsx" };
		const db = catalogDb([[/FROM catalog\.environment_references/, [{ reference_id: 12, environment_name: "Prod" }]]]);
		await expect(catalog.startExecution(db, { ...base, package: "Nope.dtsx" })).rejects.toThrow(/Packages: LoadSales.dtsx, MergeSales.dtsx/);
		await expect(catalog.startExecution(db, { ...base, parameters: [{ name: "Batch", value: "1" }] })).rejects.toThrow(/No parameter "Batch"[\s\S]*package:BatchSize/);
		await expect(catalog.startExecution(db, { ...base, parameters: [{ name: "BatchSize", value: "lots" }] })).rejects.toThrow(/BatchSize is Int32; "lots" is not a number/);
		await expect(catalog.startExecution(db, { ...base, environment: "QA" })).rejects.toThrow(/Referenced environments: Prod/);
		expect(db.sqlMatching(/create_execution/)).toHaveLength(0);
		await expect(catalog.startExecution(new FakeDb([]), base)).rejects.toThrow(/No project ETL\/Sales/);
	});

	it("explains the SQL-authentication refusal", async () => {
		const db = catalogDb([[/create_execution/, new Error("The operation cannot be started by an account that uses SQL Server Authentication.")]]);
		await expect(catalog.startExecution(db, { folder: "ETL", project: "Sales", package: "LoadSales.dtsx" })).rejects.toThrow(/"auth": "ntlm"/);
	});

	it("waits until the execution leaves an active state, or gives up at the timeout", async () => {
		const statuses = [5, 2, 2, 7];
		const db = new FakeDb([[/FROM catalog\.executions/, () => [{ status: statuses.shift() }]]]);
		const polls: string[] = [];
		expect(await catalog.waitForExecution(db, 1, { sleep: async () => {}, onPoll: (s) => polls.push(s) })).toEqual({ status: "succeeded", finished: true });
		expect(polls).toEqual(["pending", "running", "running"]);

		const stuck = new FakeDb([[/FROM catalog\.executions/, [{ status: 2 }]]]);
		expect(await catalog.waitForExecution(stuck, 1, { timeoutSeconds: 0, sleep: async () => {} })).toEqual({ status: "running", finished: false });
	});

	it("stops an execution", async () => {
		const db = new FakeDb([]);
		await catalog.stopExecution(db, 77);
		expect(db.calls[0]).toEqual({ sql: "EXEC catalog.stop_operation @operation_id = @id;", params: { id: 77 } });
	});

	it("sets object parameters as literals or environment references", async () => {
		const db = catalogDb();
		expect(await catalog.setParameter(db, { folder: "ETL", project: "Sales", package: "LoadSales.dtsx", name: "batchsize", value: "10" })).toEqual({ scope: "package", dataType: "Int32" });
		let call = db.sqlMatching(/set_object_parameter_value/)[0]!;
		expect(call.sql).toContain("CAST(@value AS int)");
		expect(call.sql).toContain("@object_type = 30");
		expect(call.params).toMatchObject({ name: "BatchSize", value: 10, object: "LoadSales.dtsx", value_type: "V" });

		await catalog.setParameter(db, { folder: "ETL", project: "Sales", name: "Environment", referencedVariable: "EnvName" });
		call = db.sqlMatching(/set_object_parameter_value/)[1]!;
		expect(call.sql).toContain("@object_type = 20");
		expect(call.params).toMatchObject({ value: "EnvName", object: "Sales", value_type: "R" });

		await expect(catalog.setParameter(db, { folder: "ETL", project: "Sales", name: "BatchSize", value: "1" })).rejects.toThrow(/No project parameter "BatchSize"/);
		await expect(catalog.setParameter(db, { folder: "ETL", project: "Sales", name: "Environment" })).rejects.toThrow(/exactly one of/);
	});

	it("sets environment variables with the variable's own type", async () => {
		const db = new FakeDb([[/FROM catalog\.environment_variables/, [{ folder: "ETL", environment: "Prod", variable: "Retries", type: "Int16", sensitive: false, value: 3 }]]]);
		expect(await catalog.setEnvironmentVariable(db, { folder: "ETL", environment: "prod", name: "retries", value: "5" })).toEqual({ dataType: "Int16" });
		const call = db.sqlMatching(/set_environment_variable_value/)[0]!;
		expect(call.sql).toContain("CAST(@value AS smallint)");
		expect(call.params).toEqual({ folder: "ETL", environment: "Prod", name: "Retries", value: 5 });
		await expect(catalog.setEnvironmentVariable(db, { folder: "ETL", environment: "Prod", name: "Nope", value: "1" })).rejects.toThrow(/Variables: Retries/);
	});

	it("deploys an .ispac, creating the folder only when asked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ssis-ispac-"));
		const ispac = join(dir, "Sales.ispac");
		writeFileSync(
			ispac,
			zipSync({
				"@Project.manifest": strToU8(`<SSIS:Project SSIS:ProtectionLevel="DontSaveSensitive" xmlns:SSIS="www.microsoft.com/SqlServer/SSIS"><SSIS:Properties><SSIS:Property SSIS:Name="Name">Sales</SSIS:Property></SSIS:Properties></SSIS:Project>`),
				"Load%20Sales.dtsx": strToU8(fixture("project/LoadSales.dtsx")),
				"Warehouse.conmgr": strToU8(fixture("project/Warehouse.conmgr")),
			}),
		);

		// The same loader the read tools use understands the archive.
		expect(loadProject(ispac)).toMatchObject({ kind: "ispac", name: "Sales" });
		expect(loadProject(ispac).packages.map((p) => p.file)).toEqual(["Load Sales.dtsx"]);
		expect(loadPackage(`${ispac}!Load Sales.dtsx`).package.connections.map((c) => c.name)).toContain("Warehouse");
		expect(() => loadPackage(`${ispac}!Missing.dtsx`)).toThrow(/Available: Load Sales.dtsx/);

		const missingFolder = new FakeDb([]);
		await expect(catalog.deployProject(missingFolder, { ispacPath: ispac, folder: "ETL" })).rejects.toThrow(/Pass createFolder/);
		expect(missingFolder.sqlMatching(/deploy_project/)).toHaveLength(0);
		await expect(catalog.deployProject(missingFolder, { ispacPath: ispac, folder: "ETL", project: "Other" })).rejects.toThrow(/contains project "Sales"/);

		const db = new FakeDb([
			[/deploy_project/, [{ operation_id: 31 }]],
			[/FROM catalog\.operations/, [{ status: 4 }]],
			[/FROM catalog\.operation_messages/, [{ message_type: 120, message: "Package validation failed" }]],
		]);
		const result = await catalog.deployProject(db, { ispacPath: ispac, folder: "ETL", createFolder: true });
		expect(result).toMatchObject({ operationId: 31, project: "Sales", status: "failed" });
		expect(result.messages).toHaveLength(1);
		expect(db.sqlMatching(/create_folder/)).toHaveLength(1);
		const deploy = db.sqlMatching(/deploy_project/)[0]!;
		expect(deploy.params).toMatchObject({ folder: "ETL", project: "Sales" });
		expect(Buffer.isBuffer(deploy.params.stream)).toBe(true);
	});
});
