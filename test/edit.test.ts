import { describe, expect, it } from "vitest";
import { findExecutable } from "../src/dtsx/model.ts";
import { parsePackage } from "../src/dtsx/parse.ts";
import { loadPackage } from "../src/dtsx/project.ts";
import { applyEdits, EditError, type EditOp } from "../src/edit/ops.ts";
import { validatePackage } from "../src/edit/validate.ts";
import { fixture, PROJECT } from "./helpers.ts";

const original = fixture("project/LoadSales.dtsx");
const project = loadPackage(`${PROJECT}/LoadSales.dtsx`).package.connections.filter((c) => c.scope === "project");

function edit(ops: EditOp[], source = original) {
	const result = applyEdits(source, ops, { projectConnections: project });
	return { ...result, pkg: parsePackage(result.source, { projectConnections: project }) };
}

/** Lines that differ between two texts, as [removed, added]. */
function diff(a: string, b: string): [string[], string[]] {
	const before = a.split("\n");
	const after = b.split("\n");
	const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
	const only = (lines: string[], other: Map<string, number>) => {
		const left = new Map(other);
		return lines.filter((l) => {
			const n = left.get(l) ?? 0;
			if (n > 0) left.set(l, n - 1);
			return n === 0;
		});
	};
	return [only(before, count(after)), only(after, count(before))];
}

describe("applyEdits", () => {
	it("changes Execute SQL text and touches only that line", () => {
		const sql = `DELETE FROM stg.Sales WHERE Loaded < '2025-01-01' AND Note = "x";\nSELECT 1 AS Remaining;`;
		const { source, pkg, notes } = edit([{ op: "set_sql", target: "Truncate staging", sql }]);
		expect(notes).toEqual([expect.stringMatching(/stores a SingleRow result in variables/)]);
		expect(edit([{ op: "set_sql", target: "Log error", sql: "etl.LogError2" }]).notes).toEqual([]);
		expect(findExecutable(pkg, "Truncate staging")!.sql!.statement).toBe(sql);
		const [removed, added] = diff(original, source);
		expect(removed).toHaveLength(1);
		expect(added).toEqual([
			`          SQLTask:SqlStatementSource="DELETE FROM stg.Sales WHERE Loaded &lt; '2025-01-01' AND Note = &quot;x&quot;;&#xA;SELECT 1 AS Remaining;"`,
		]);
	});

	it("preserves CRLF line endings and the byte order mark", () => {
		const windows = `\uFEFF${original.replace(/\n/g, "\r\n")}`;
		const { source } = edit([{ op: "add_variable", name: "BatchId", dataType: "Int32", value: "5" }, { op: "set_disabled", target: "Run merge package", disabled: true }], windows);
		expect(source.startsWith("\uFEFF<?xml")).toBe(true);
		expect(source.replace(/\r\n/g, "")).not.toContain("\n");
		expect(source).toContain(`      DTS:ObjectName="BatchId">\r\n      <DTS:VariableValue\r\n        DTS:DataType="3">5</DTS:VariableValue>\r\n    </DTS:Variable>\r\n  </DTS:Variables>`);
	});

	it("sets data flow component properties and warns about stale metadata", () => {
		const { pkg } = edit([{ op: "set_property", target: "Write staging", property: "OpenRowset", value: "[stg].[SalesV2]" }]);
		expect(findExecutable(pkg, "Load file")!.dataFlow!.components[2]!.properties.OpenRowset).toBe("[stg].[SalesV2]");
		expect(() => edit([{ op: "set_property", target: "Write staging", property: "Nope", value: "1" }])).toThrow(/Available: CommandTimeout, OpenRowset, AccessMode/);
		expect(() => edit([{ op: "set_sql", target: "Write staging", sql: "x" }])).toThrow(/no SqlCommand property/);
	});

	it("sets, creates and protects task properties", () => {
		const { source, pkg } = edit([
			{ op: "set_property", target: "Notify failure", property: "Subject", value: "LoadSales <failed>" },
			{ op: "set_property", target: "Truncate staging", property: "MaxErrorCount", value: "3" },
		]);
		expect(findExecutable(pkg, "Notify failure")!.taskProperties!.Subject).toBe("LoadSales <failed>");
		expect(findExecutable(pkg, "Truncate staging")!.properties.MaxErrorCount).toBe("3");
		expect(source).toContain(`      DTS:ThreadHint="0"\n      DTS:MaxErrorCount="3">`);
		expect(() => edit([{ op: "set_property", target: "Truncate staging", property: "DTSID", value: "{x}" }])).toThrow(/cannot be changed/);
		expect(() => edit([{ op: "set_property", target: "Truncate staging", property: "Bogus", value: "1" }])).toThrow(/Existing properties/);
	});

	it("edits connection strings and expressions", () => {
		const { pkg, notes } = edit([
			{ op: "set_connection_string", connection: "Staging", value: "Data Source=sql02;Initial Catalog=Staging;" },
			{ op: "set_connection_string", connection: "SalesFile", value: "D:\\in\\sales.csv" },
			{ op: "set_expression", target: "Truncate staging", property: "SqlStatementSource", expression: `"TRUNCATE TABLE " + @[User::CurrentFile]` },
			{ op: "set_expression", target: "SalesFile", property: "ConnectionString", expression: `@[$Package::ImportFolder] + "\\\\sales.csv"` },
		]);
		expect(pkg.connections[0]!.connectionString).toBe("Data Source=sql02;Initial Catalog=Staging;");
		expect(pkg.connections[1]!.connectionString).toBe("D:\\in\\sales.csv");
		expect(pkg.connections[1]!.expressions.ConnectionString).toBe(`@[$Package::ImportFolder] + "\\\\sales.csv"`);
		expect(findExecutable(pkg, "Truncate staging")!.expressions).toEqual({ SqlStatementSource: `"TRUNCATE TABLE " + @[User::CurrentFile]` });
		expect(notes.join(" ")).toMatch(/overrides the stored value/);

		const removed = edit([{ op: "set_expression", target: "SalesFile", property: "ConnectionString" }]);
		expect(removed.pkg.connections[1]!.expressions).toEqual({});
		expect(diff(original, removed.source)[1]).toEqual([]);
		expect(() => edit([{ op: "set_expression", target: "Staging", property: "ConnectionString" }])).toThrow(/no expression/);
	});

	it("places a new expression before the task settings, as the designer does", () => {
		const { source } = edit([{ op: "set_expression", target: "Truncate staging", property: "Disable", expression: "@[User::RowCount] > 5" }]);
		expect(source).toContain(`      <DTS:Variables />\n      <DTS:PropertyExpression\n        DTS:Name="Disable">@[User::RowCount] &gt; 5</DTS:PropertyExpression>\n      <DTS:ObjectData>`);
	});

	it("adds, renames and removes variables", () => {
		const added = edit([
			{ op: "add_variable", name: "Threshold", dataType: "Int32", value: "10" },
			{ op: "add_variable", name: "Label", expression: `"x" + @[User::CurrentFile]` },
			{ op: "add_variable", name: "IsFull", dataType: "Boolean", value: "true" },
			{ op: "add_variable", name: "Local", scope: "For each sales file" },
		]);
		const vars = added.pkg.root.variables;
		expect(vars.find((v) => v.name === "Threshold")).toMatchObject({ dataType: "Int32", value: "10" });
		expect(vars.find((v) => v.name === "Label")).toMatchObject({ dataType: "String", expression: `"x" + @[User::CurrentFile]` });
		expect(vars.find((v) => v.name === "IsFull")!.value).toBe("-1");
		expect(findExecutable(added.pkg, "For each sales file")!.variables.map((v) => v.name)).toEqual(["Local"]);
		expect(added.source).toContain(`      <DTS:Variables>\n        <DTS:Variable\n          DTS:CreationName=""`);
		expect(added.issues.filter((i) => i.severity === "error")).toEqual([]);

		expect(() => edit([{ op: "add_variable", name: "RowCount" }])).toThrow(/already exists/);
		expect(() => edit([{ op: "add_variable", name: "9lives" }])).toThrow(/not a valid variable name/);
		expect(() => edit([{ op: "add_variable", name: "N", dataType: "Int32", value: "abc" }])).toThrow(/not a valid Int32/);
		expect(() => edit([{ op: "add_variable", name: "N", dataType: "Varchar" }])).toThrow(/Unknown data type/);

		const renamed = edit([{ op: "rename_variable", name: "CurrentFile", newName: "FilePath" }]);
		expect(renamed.source).not.toContain("User::CurrentFile");
		expect(renamed.source).toContain(`ReadOnlyVariables="User::FilePath,RowCount"`);
		expect(renamed.source).toContain(`Dts.Variables["User::FilePath"]`);
		expect(renamed.pkg.connections[1]!.expressions.ConnectionString).toBe("@[User::FilePath]");
		expect(findExecutable(renamed.pkg, "For each sales file")!.forEach!.variableMappings[0]!.variable).toBe("User::FilePath");
		expect(validatePackage(renamed.source).issues).toEqual([]);

		const bare = edit([{ op: "rename_variable", name: "RowCount", newName: "Rows" }]);
		expect(bare.source).toContain(`ReadOnlyVariables="User::CurrentFile,Rows"`);
		expect(bare.pkg.root.variables[2]!.expression).toContain("@[User::Rows]");

		expect(() => edit([{ op: "remove_variable", name: "RowCount" }])).toThrow(/still referenced in \d+ place/);
		const removed = edit([{ op: "add_variable", name: "Temp" }, { op: "remove_variable", name: "User::Temp" }]);
		expect(removed.source).toBe(original);
	});

	it("adds, renames and removes package parameters", () => {
		const added = edit([{ op: "add_parameter", name: "BatchSize", dataType: "Int32", value: "500", required: true, description: "Rows per batch" }]);
		expect(added.pkg.parameters[1]).toEqual({ name: "BatchSize", dataType: "Int32", value: "500", required: true, sensitive: false, description: "Rows per batch", scope: "package" });

		const renamed = edit([{ op: "rename_parameter", name: "ImportFolder", newName: "SourceFolder" }]);
		expect(renamed.pkg.parameters[0]!.name).toBe("SourceFolder");
		expect(findExecutable(renamed.pkg, "For each sales file")!.forEach!.properties["Directory (expression)"]).toBe("@[$Package::SourceFolder]");

		expect(() => edit([{ op: "remove_parameter", name: "ImportFolder" }])).toThrow(/still referenced/);
		const forced = edit([{ op: "remove_parameter", name: "$Package::ImportFolder", force: true }]);
		expect(forced.pkg.parameters).toEqual([]);
		expect(forced.issues.some((i) => i.severity === "warning" && i.message.includes("$Package::ImportFolder"))).toBe(true);
	});

	it("creates the parameters section in the designer's position when missing", () => {
		const merge = fixture("project/MergeSales.dtsx").replace(/  <DTS:PackageParameters>[\s\S]*<\/DTS:PackageParameters>\n/, "");
		const { source } = edit([{ op: "add_parameter", name: "P" }], merge);
		expect(source).toMatch(/PackageFormatVersion">8<\/DTS:Property>\n  <DTS:PackageParameters>\n    <DTS:PackageParameter[\s\S]*<\/DTS:PackageParameters>\n  <DTS:Variables \/>/);
	});

	it("adds an Execute SQL task wired after an existing task", () => {
		const { source, pkg, notes } = edit([
			{ op: "add_execute_sql_task", name: "Update stats", connection: "Warehouse", sql: "EXEC dbo.UpdateStats;", after: "Run merge package" },
		]);
		const task = findExecutable(pkg, "Package\\Update stats")!;
		expect(task.kind).toBe("ExecuteSQL");
		expect(task.sql).toMatchObject({ connection: "Warehouse", statement: "EXEC dbo.UpdateStats;" });
		expect(pkg.root.constraints.at(-1)).toMatchObject({ name: "Constraint 3", from: "Package\\Run merge package", to: "Package\\Update stats", value: "Success" });
		expect(source).toContain(`          SQLTask:SqlStatementSource="EXEC dbo.UpdateStats;" xmlns:SQLTask="www.microsoft.com/sqlserver/dts/tasks/sqltask" />`);
		expect(notes.join(" ")).toMatch(/places it automatically/);
		expect(diff(original, source)[0]).toEqual([]);

		const nested = edit([{ op: "add_execute_sql_task", name: "Mark file", connection: "Staging", sql: "SELECT 1", parent: "For each sales file" }]);
		expect(findExecutable(nested.pkg, "Package\\For each sales file\\Mark file")).toBeDefined();

		expect(() => edit([{ op: "add_execute_sql_task", name: "Truncate staging", connection: "Staging", sql: "x" }])).toThrow(/already exists/);
		expect(() => edit([{ op: "add_execute_sql_task", name: "T", connection: "Missing", sql: "x" }])).toThrow(/Available: Staging, SalesFile, Warehouse/);
		expect(() => edit([{ op: "add_execute_sql_task", name: "T", connection: "Staging", sql: "x", parent: "Truncate staging" }])).toThrow(/not a container/);
	});

	it("creates the constraints section when a container has none", () => {
		const merge = fixture("project/MergeSales.dtsx");
		const { pkg, source } = edit([{ op: "add_execute_sql_task", name: "Audit", connection: "Warehouse", sql: "EXEC dbo.Audit", after: "Merge into fact" }], merge);
		expect(pkg.root.constraints).toHaveLength(1);
		expect(source).toMatch(/<\/DTS:Executables>\n  <DTS:PrecedenceConstraints>\n    <DTS:PrecedenceConstraint\n      DTS:refId="Package.PrecedenceConstraints\[Constraint\]"/);
	});

	it("adds and removes precedence constraints", () => {
		const { pkg } = edit([
			{ op: "add_constraint", from: "Run merge package", to: "Notify failure", value: "failure", expression: "@[User::RowCount] == 0", combine: "or", logicalAnd: false },
		]);
		expect(pkg.root.constraints.at(-1)).toEqual({
			name: "Constraint 3",
			from: "Package\\Run merge package",
			to: "Package\\Notify failure",
			value: "Failure",
			evalOp: "ExpressionOrConstraint",
			expression: "@[User::RowCount] == 0",
			logicalAnd: false,
		});

		const removed = edit([{ op: "remove_constraint", from: "For each sales file", to: "Notify failure" }]);
		expect(removed.pkg.root.constraints.map((c) => c.name)).toEqual(["Constraint", "Constraint 1"]);
		const emptied = edit([{ op: "remove_constraint", from: "Load file", to: "Archive file" }]);
		expect(findExecutable(emptied.pkg, "For each sales file")!.constraints).toEqual([]);
		expect(emptied.source).not.toMatch(/<DTS:PrecedenceConstraints>\s*<\/DTS:PrecedenceConstraints>/);

		expect(() => edit([{ op: "add_constraint", from: "Truncate staging", to: "Load file" }])).toThrow(/same container/);
		expect(() => edit([{ op: "add_constraint", from: "Truncate staging", to: "For each sales file" }])).toThrow(/already exists/);
		expect(() => edit([{ op: "remove_constraint", from: "Truncate staging", to: "Notify failure" }])).toThrow(/No precedence constraint/);
	});

	it("rejects an edit that would create a cycle, leaving nothing to write", () => {
		expect(() => edit([{ op: "add_constraint", from: "Run merge package", to: "Truncate staging" }])).toThrow(/would break the package[\s\S]*cycle/);
	});

	it("enables and disables tasks", () => {
		const disabled = edit([{ op: "set_disabled", target: "Truncate staging", disabled: true }]);
		expect(findExecutable(disabled.pkg, "Truncate staging")!.disabled).toBe(true);
		const enabled = edit([{ op: "set_disabled", target: "Notify failure", disabled: false }]);
		expect(findExecutable(enabled.pkg, "Notify failure")!.disabled).toBe(false);
		expect(diff(original, enabled.source)).toEqual([[`      DTS:Disabled="True"`], []]);
	});

	it("names the failing operation and applies nothing when one of several fails", () => {
		expect(() => edit([{ op: "set_disabled", target: "Truncate staging", disabled: true }, { op: "set_sql", target: "Ghost", sql: "x" }])).toThrow(/Operation 2 \(set_sql\): Nothing named "Ghost"/);
		expect(() => edit([{ op: "nope" } as unknown as EditOp])).toThrow(EditError);
	});

	it("edits a project connection manager file and refuses legacy packages", () => {
		const conmgr = fixture("project/Warehouse.conmgr");
		const out = applyEdits(conmgr, [{ op: "set_connection_string", connection: "Warehouse", value: "Data Source=prod;" }]);
		expect(out.source).toContain(`DTS:ConnectionString="Data Source=prod;" />`);
		expect(() => applyEdits(conmgr, [{ op: "add_variable", name: "X" }])).toThrow(/Only set_connection_string/);
		expect(() => applyEdits(fixture("Legacy2008.dtsx"), [{ op: "add_variable", name: "X" }])).toThrow(/read-only here/);
	});
});

describe("validatePackage", () => {
	it("accepts the fixtures", () => {
		expect(validatePackage(original, { projectConnections: project }).issues).toEqual([]);
		expect(validatePackage(fixture("Legacy2008.dtsx")).issues).toEqual([]);
	});

	it("reports broken references", () => {
		const broken = original
			.replace(`DTS:To="Package\\Notify failure"`, `DTS:To="Package\\Gone"`)
			.replace(`SQLTask:DtsVariableName="User::RowCount"`, `SQLTask:DtsVariableName="User::Missing"`)
			.replace(`DTS:DTSID="{55555555-0000-0000-0000-000000000007}"`, `DTS:DTSID="{55555555-0000-0000-0000-000000000001}"`)
			.replace(`lineageId="Package\\For each sales file\\Load file\\Add audit columns.Outputs[Derived Column Output].Columns[AmountNumeric]" />`, `lineageId="Package\\nowhere" />`)
			.replace(`startId="Package\\For each sales file\\Load file\\Read file.Outputs[Flat File Source Output]" />`, `startId="bad" />`);
		const messages = validatePackage(broken, { projectConnections: project }).issues.map((i) => `${i.severity}: ${i.message}`);
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^error: Duplicate DTSID \{55555555-0000-0000-0000-000000000001\}/),
				expect.stringMatching(/^error: Precedence constraint "Constraint 2" ends at "Package\\Gone"/),
				expect.stringMatching(/^error: Data flow path "Flat File Source Output" starts at unknown output bad/),
				expect.stringMatching(/^error: Input column "AmountNumeric" refers to upstream column Package\\nowhere/),
				expect.stringMatching(/^warning: result Remaining refers to User::Missing, which is not declared/),
			]),
		);
	});

	it("reports malformed XML as a single error", () => {
		const { issues } = validatePackage(original.replace("</DTS:Variables>", ""));
		expect(issues).toHaveLength(1);
		expect(issues[0]!.severity).toBe("error");
	});
});
