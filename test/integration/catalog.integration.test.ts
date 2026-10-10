/**
 * Runs the catalog code against a real SQL Server holding the stub schema in
 * stub-catalog.sql. Skipped unless PI_SSIS_TEST_SERVER is set, e.g.
 *
 *   docker run -d --rm -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='...' -p 127.0.0.1:14339:1433 mcr.microsoft.com/mssql/server:2022-latest
 *   PI_SSIS_TEST_SERVER=127.0.0.1 PI_SSIS_TEST_PORT=14339 PI_SSIS_TEST_PASSWORD='...' npm test
 *
 * This proves the SQL parses, parameters bind with the right types and the
 * driver round-trips values. It does not prove behaviour against a real SSISDB.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as catalog from "../../src/catalog/catalog.ts";
import type { Profile } from "../../src/catalog/config.ts";
import { connect, type SqlExecutor } from "../../src/catalog/executor.ts";
import { FIXTURES } from "../helpers.ts";

const server = process.env.PI_SSIS_TEST_SERVER;
const profile = (database: string): Profile => ({
	name: "it",
	server: server!,
	port: Number(process.env.PI_SSIS_TEST_PORT ?? 1433),
	database,
	auth: "sql",
	user: process.env.PI_SSIS_TEST_USER ?? "sa",
	passwordEnv: "PI_SSIS_TEST_PASSWORD",
	encrypt: true,
	trustServerCertificate: true,
	source: "test",
});

describe.skipIf(!server)("catalog against SQL Server (stub schema)", () => {
	let db: SqlExecutor;
	const database = `SSISDB_stub_${Date.now()}`;

	beforeAll(async () => {
		const master = await connect(profile("master"));
		await master.query(`CREATE DATABASE [${database}]`);
		await master.close();
		db = await connect(profile(database));
		const script = readFileSync(join(FIXTURES, "..", "integration", "stub-catalog.sql"), "utf8");
		for (const batch of script.split(/^GO\s*$/m)) if (batch.trim()) await db.query(batch);
	}, 60_000);

	afterAll(async () => {
		await db?.close();
		const master = await connect(profile("master"));
		await master.query(`ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]`);
		await master.close();
	});

	it("reads folders, projects, packages, parameters and environments", async () => {
		expect(await catalog.listFolders(db)).toEqual([{ name: "ETL", description: "Nightly loads", projects: 1, environments: 1 }]);
		expect(await catalog.listProjects(db)).toMatchObject([{ folder: "ETL", project: "Sales", packages: 2, deployed_by_name: "CORP\\deployer" }]);
		expect(await catalog.listProjects(db, "Nope")).toEqual([]);
		expect((await catalog.listPackages(db, "ETL", "Sales")).map((p) => p.package)).toEqual(["LoadSales.dtsx", "MergeSales.dtsx"]);

		const all = await catalog.listParameters(db, "ETL", "Sales");
		expect(all.map((p) => `${p.scope}:${p.parameter_name}`)).toEqual(["project:ApiKey", "project:Environment", "package:BatchSize", "package:FullLoad", "package:ImportFolder", "package:MaxRows", "package:Since"]);
		expect(all.find((p) => p.parameter_name === "ApiKey")!.default_value).toBe("<sensitive>");
		expect(all.find((p) => p.parameter_name === "BatchSize")!.default_value).toBe(100);
		expect((await catalog.listParameters(db, "ETL", "Sales", "MergeSales.dtsx")).map((p) => p.parameter_name)).toEqual(["ApiKey", "Environment"]);

		const env = await catalog.listEnvironments(db, "ETL");
		expect(env.environments).toMatchObject([{ folder: "ETL", environment: "Prod" }]);
		expect(env.variables.map((v) => `${v.variable}=${v.value}`)).toEqual(["Password=<sensitive>", "Retries=3"]);
		expect(env.references).toMatchObject([{ project: "Sales", environment: "Prod" }]);
	});

	it("filters executions and diagnoses a failure", async () => {
		expect((await catalog.listExecutions(db, { status: "failed", sinceHours: 1 })).map((e) => e.execution_id)).toEqual(["42"]);
		expect(await catalog.listExecutions(db, { status: "running" })).toEqual([]);
		expect(await catalog.listExecutions(db, { folder: "ETL", project: "Sales", package: "LoadSales.dtsx", limit: 1 })).toHaveLength(1);
		expect(await catalog.executionMessages(db, 42, "errors")).toHaveLength(2);
		expect(await catalog.executionMessages(db, 42, "warnings")).toHaveLength(3);

		const text = catalog.renderDiagnosis(await catalog.diagnose(db, 42), 42);
		expect(text).toContain("# Execution #42: failed");
		expect(text).toContain("ran 3m0s, as CORP\\svc, environment Prod");
		expect(text).toContain("- \\Package\\For each sales file\\Load file (LoadSales.dtsx, 1200 ms)");
		expect(text.match(/Cannot insert the value NULL/g)).toHaveLength(1);
		expect(text).toContain("- package:BatchSize = 50");
		expect(text).toContain("- project:ApiKey = <sensitive>");
		expect(text).not.toContain("top-secret");
	});

	it("starts an execution with correctly typed parameter values", async () => {
		const id = await catalog.startExecution(db, {
			folder: "ETL",
			project: "Sales",
			package: "LoadSales.dtsx",
			environment: "Prod",
			loggingLevel: 3,
			use32Bit: true,
			parameters: [
				{ name: "BatchSize", value: "250" },
				{ name: "FullLoad", value: "true" },
				{ name: "Since", value: "2026-01-02T03:04:05Z" },
				{ name: "MaxRows", value: "5000000000" },
				{ name: "ImportFolder", value: "D:\\It's here" },
				{ name: "Environment", value: "Prod" },
			],
		});
		expect(id).toBeGreaterThanOrEqual(100);
		const values = await db.query("SELECT object_type, parameter_name, CAST(parameter_value AS nvarchar(200)) AS value, base_type FROM catalog.execution_parameter_values WHERE execution_id = @id ORDER BY execution_parameter_id", { id });
		expect(values.map((v) => `${v.object_type} ${v.parameter_name}=${v.value} (${v.base_type})`)).toEqual([
			"50 LOGGING_LEVEL=3 (smallint)",
			"30 BatchSize=250 (int)",
			"30 FullLoad=1 (bit)",
			"30 Since=Jan  2 2026  3:04AM (datetime2)",
			"30 MaxRows=5000000000 (bigint)",
			"30 ImportFolder=D:\\It's here (nvarchar)",
			"20 Environment=Prod (nvarchar)",
		]);
		const [row] = await db.query("SELECT reference_id, use32bitruntime, environment_name FROM catalog.executions WHERE execution_id = @id", { id });
		expect(row).toMatchObject({ reference_id: "1", use32bitruntime: true, environment_name: "Prod" });
		expect(await catalog.waitForExecution(db, id)).toEqual({ status: "succeeded", finished: true });

		const plain = await catalog.startExecution(db, { folder: "ETL", project: "Sales", package: "MergeSales.dtsx" });
		expect((await db.query("SELECT reference_id FROM catalog.executions WHERE execution_id = @id", { id: plain }))[0]!.reference_id).toBeNull();
		await catalog.stopExecution(db, plain);
		expect((await catalog.executionStatus(db, plain))!.status).toBe(3);
	});

	it("sets parameter defaults and environment variables", async () => {
		await catalog.setParameter(db, { folder: "ETL", project: "Sales", package: "LoadSales.dtsx", name: "BatchSize", value: "10" });
		await catalog.setParameter(db, { folder: "ETL", project: "Sales", name: "Environment", referencedVariable: "EnvName" });
		await catalog.setEnvironmentVariable(db, { folder: "ETL", environment: "Prod", name: "Retries", value: "5" });
		const calls = await db.query("SELECT name, detail FROM catalog.stub_calls WHERE name LIKE 'set_%' ORDER BY id");
		expect(calls.map((c) => c.detail)).toEqual([
			"30 ETL/Sales/LoadSales.dtsx BatchSize=10 V int",
			"20 ETL/Sales/Sales Environment=EnvName R nvarchar",
			"ETL/Prod/Retries=5 smallint",
		]);
	});

	it("deploys an .ispac as binary and creates the folder on request", async () => {
		const ispac = join(mkdtempSync(join(tmpdir(), "pi-ssis-it-")), "Sales.ispac");
		writeFileSync(ispac, zipSync({ "@Project.manifest": strToU8(`<SSIS:Project xmlns:SSIS="www.microsoft.com/SqlServer/SSIS"><SSIS:Properties><SSIS:Property SSIS:Name="Name">Sales</SSIS:Property></SSIS:Properties></SSIS:Project>`) }));
		await expect(catalog.deployProject(db, { ispacPath: ispac, folder: "New" })).rejects.toThrow(/Pass createFolder/);
		const result = await catalog.deployProject(db, { ispacPath: ispac, folder: "New", createFolder: true });
		expect(result).toMatchObject({ project: "Sales", status: "succeeded", messages: [] });
		expect((await catalog.listFolders(db)).map((f) => f.name)).toEqual(["ETL", "New"]);
		const [call] = await db.query("SELECT detail FROM catalog.stub_calls WHERE name = 'deploy_project'");
		expect(call!.detail).toBe(`New/Sales bytes=${readFileSync(ispac).length} zip=yes`);
	});
});
