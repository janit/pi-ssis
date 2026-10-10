import { describe, expect, it } from "vitest";
import { collectFacts, searchFacts } from "../src/dtsx/facts.ts";
import { findExecutable, walk } from "../src/dtsx/model.ts";
import { EncryptedPackageError, parsePackage } from "../src/dtsx/parse.ts";
import { loadPackage, loadProject } from "../src/dtsx/project.ts";
import { fixture, PROJECT } from "./helpers.ts";

const pkg = () => loadPackage(`${PROJECT}/LoadSales.dtsx`).package;

describe("parsePackage", () => {
	it("reads package identity, connections, parameters and variables", () => {
		const p = pkg();
		expect(p.name).toBe("LoadSales");
		expect(p.formatVersion).toBe(8);
		expect(p.protectionLevel).toBe("DontSaveSensitive");
		expect(p.connections.map((c) => `${c.name}:${c.type}:${c.scope}`)).toEqual([
			"Staging:OLEDB:package",
			"SalesFile:FLATFILE:package",
			"Warehouse:OLEDB:project",
		]);
		const file = p.connections[1]!;
		expect(file.expressions.ConnectionString).toBe("@[User::CurrentFile]");
		expect(file.flatFileColumns).toEqual([
			{ name: "OrderId", dataType: "String", width: "20", delimiter: "," },
			{ name: "Amount", dataType: "String", width: "30", delimiter: "\\r\\n" },
		]);
		expect(p.parameters).toEqual([
			{ name: "ImportFolder", dataType: "String", value: "C:\\Import", required: true, sensitive: false, description: "Folder scanned for sales files", scope: "package" },
		]);
		expect(p.root.variables.map((v) => `${v.namespace}::${v.name} ${v.dataType}`)).toEqual([
			"User::CurrentFile String",
			"User::RowCount Int32",
			"User::Summary String",
		]);
		expect(p.root.variables[2]!.expression).toContain("@[User::RowCount]");
	});

	it("reads the control flow tree, constraints and event handlers", () => {
		const p = pkg();
		expect(p.root.children.map((c) => `${c.kind}:${c.name}`)).toEqual([
			"ExecuteSQL:Truncate staging",
			"ForEachLoop:For each sales file",
			"ExecutePackage:Run merge package",
			"SendMail:Notify failure",
		]);
		expect(p.root.constraints).toEqual([
			{ name: "Constraint", from: "Package\\Truncate staging", to: "Package\\For each sales file", value: "Success", evalOp: "Constraint", expression: undefined, logicalAnd: true },
			{ name: "Constraint 1", from: "Package\\For each sales file", to: "Package\\Run merge package", value: "Success", evalOp: "ExpressionAndConstraint", expression: "@[User::RowCount] > 0", logicalAnd: true },
			{ name: "Constraint 2", from: "Package\\For each sales file", to: "Package\\Notify failure", value: "Failure", evalOp: "Constraint", expression: undefined, logicalAnd: true },
		]);
		expect(p.root.eventHandlers.map((h) => `${h.name}:${h.children[0]!.name}`)).toEqual(["OnError:Log error"]);
		expect(findExecutable(p, "Notify failure")!.disabled).toBe(true);
		expect(findExecutable(p, "notify FAILURE")!.taskProperties).toEqual({ To: "etl@example.com", Subject: "LoadSales failed" });
	});

	it("reads task details", () => {
		const p = pkg();
		const sql = findExecutable(p, "Package\\Truncate staging")!.sql!;
		expect(sql.connection).toBe("Staging");
		expect(sql.statement).toBe("TRUNCATE TABLE stg.Sales;\nSELECT COUNT(*) AS Remaining FROM stg.Sales WHERE Amount < 0;");
		expect(sql.resultType).toBe("SingleRow");
		expect(sql.resultBindings).toEqual([{ name: "Remaining", variable: "User::RowCount" }]);

		const loop = findExecutable(p, "For each sales file")!.forEach!;
		expect(loop.enumerator).toBe("ForEachFileEnumerator");
		expect(loop.properties.FileSpec).toBe("sales_*.csv");
		expect(loop.variableMappings).toEqual([{ variable: "User::CurrentFile", index: 0 }]);

		const script = findExecutable(p, "Archive file")!.script!;
		expect(script.language).toBe("CSharp");
		expect(script.readOnlyVariables).toEqual(["User::CurrentFile", "RowCount"]);
		expect(script.files.map((f) => f.name)).toEqual(["ScriptMain.cs"]);
		expect(script.files[0]!.code).toContain("System.IO.File.Move");

		expect(findExecutable(p, "Run merge package")!.executePackage).toEqual({
			packageName: "MergeSales.dtsx",
			useProjectReference: true,
			connection: undefined,
			parameterAssignments: [{ parameter: "RowsLoaded", source: "User::RowCount" }],
		});
		expect(findExecutable(p, "Log error")!.sql!.isStoredProc).toBe(true);
	});

	it("reads data flow components, lineage and mappings", () => {
		const flow = findExecutable(pkg(), "Load file")!.dataFlow!;
		expect(flow.components.map((c) => `${c.name}:${c.kind}`)).toEqual([
			"Read file:FlatFileSource",
			"Add audit columns:DerivedColumn",
			"Write staging:OLEDBDestination",
		]);
		expect(flow.paths.map((p) => `${p.fromComponent}>${p.toComponent}`)).toEqual(["Read file>Add audit columns", "Add audit columns>Write staging"]);
		expect(flow.components[0]!.connections[0]!.manager).toBe("SalesFile");
		const derived = flow.components[1]!.outputs[0]!.columns;
		expect(derived.map((c) => `${c.name} ${c.dataType} ${c.properties.FriendlyExpression}`)).toEqual([
			"AmountNumeric numeric(18,2) (DT_NUMERIC,18,2)Amount",
			"SourceFile wstr(260) @[User::CurrentFile]",
		]);
		const dest = flow.components[2]!.inputs[0]!;
		expect(dest.columns.map((c) => c.name)).toEqual(["OrderId", "AmountNumeric"]);
		expect(dest.externalColumns.map((c) => c.name)).toEqual(["OrderId", "Amount", "LoadedAt"]);
	});

	it("resolves project connection managers by id", () => {
		const merge = loadPackage(`${PROJECT}/MergeSales.dtsx`).package;
		const task = findExecutable(merge, "Merge into fact")!;
		expect(task.sql!.connection).toBe("Warehouse");
		expect(task.properties.TransactionOption).toBe("Required");
	});

	it("reads the legacy 2005/2008 element-based format", () => {
		const p = parsePackage(fixture("Legacy2008.dtsx"));
		expect(p.name).toBe("Legacy2008");
		expect(p.formatVersion).toBe(3);
		expect(p.connections[0]!.connectionString).toContain("Initial Catalog=Legacy");
		expect(p.configurations).toEqual([{ name: "FileConfig", type: "ConfigFile", target: undefined, source: "C:\\config\\legacy.dtsConfig" }]);
		expect(p.root.variables[0]).toMatchObject({ name: "BatchId", dataType: "Int32", value: "7" });
		expect(p.root.children.map((c) => `${c.kind}:${c.name}:${c.sql!.connection}`)).toEqual(["ExecuteSQL:First:Legacy", "ExecuteSQL:Second:Legacy"]);
		expect(p.root.constraints[0]).toMatchObject({ from: "Package\\First", to: "Package\\Second", value: "Completion" });
	});

	it("refuses fully encrypted packages with an explanation", () => {
		expect(() => parsePackage(fixture("Encrypted.dtsx"))).toThrow(EncryptedPackageError);
		expect(() => parsePackage("<html></html>")).toThrow(/Not an SSIS package/);
	});
});

describe("loadProject", () => {
	it("loads packages, project connections and parameters from a directory", () => {
		const project = loadProject(PROJECT);
		expect(project.name).toBe("Sales");
		expect(project.protectionLevel).toBe("DontSaveSensitive");
		expect(project.packages.map((p) => p.file)).toEqual(["LoadSales.dtsx", "MergeSales.dtsx"]);
		expect(project.connections.map((c) => c.name)).toEqual(["Warehouse"]);
		expect(project.parameters).toEqual([
			{ name: "Environment", dataType: "String", value: "Dev", required: false, sensitive: false, description: "Deployment environment name", scope: "project" },
			{ name: "ApiKey", dataType: "String", value: "<sensitive>", required: true, sensitive: true, description: undefined, scope: "project" },
		]);
	});

	it("reports unreadable packages without failing the whole project", () => {
		const project = loadProject(`${PROJECT}/..`);
		const encrypted = project.packages.find((p) => p.file === "Encrypted.dtsx")!;
		expect(encrypted.package).toBeUndefined();
		expect(encrypted.error).toMatch(/EncryptAll/);
		expect(project.packages.filter((p) => p.package).length).toBeGreaterThanOrEqual(3);
	});

	it("explains a bad path", () => {
		expect(() => loadProject(`${PROJECT}/nope`)).toThrow(/not found/i);
		expect(() => loadPackage(PROJECT)).toThrow(/is a project, not a package/);
	});
});

describe("search", () => {
	it("finds tables, variables and settings with their location", () => {
		const facts = collectFacts(pkg());
		expect(searchFacts(facts, "stg.sales").map((h) => `${h.where}|${h.field}`)).toEqual(["Package\\Truncate staging|sql"]);
		expect(searchFacts(facts, "[stg].[Sales]").map((h) => h.where)).toEqual(["Package\\For each sales file\\Load file :: Write staging"]);
		const uses = searchFacts(facts, "User::CurrentFile").map((h) => h.where);
		expect(uses).toContain("Connection SalesFile");
		expect(uses).toContain("Package\\For each sales file\\Archive file");
		expect(searchFacts(facts, "amount\\s*<\\s*0", { regex: true })).toHaveLength(1);
		expect(searchFacts(facts, "nothing-like-this")).toEqual([]);
	});

	it("visits event handlers when walking", () => {
		const names: string[] = [];
		walk(pkg().root, (e) => names.push(e.name));
		expect(names).toContain("Log error");
	});
});
