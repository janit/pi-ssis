import type { Component, Connection, Executable, Package } from "../dtsx/model.ts";
import { walk } from "../dtsx/model.ts";
import type { Project } from "../dtsx/project.ts";
import { topoSort } from "../render/text.ts";

export type Complexity = "low" | "medium" | "high";

export interface InventoryItem {
	where: string;
	kind: string;
	name: string;
	/** What the item does, in target-neutral terms. */
	summary: string;
	complexity: Complexity;
	notes: string[];
}

export interface Inventory {
	package: string;
	items: InventoryItem[];
	connections: { name: string; type: string; notes: string[] }[];
	/** Things that have no straightforward equivalent outside SSIS. */
	blockers: string[];
	/** Package-level concerns that are not tied to one task. */
	considerations: string[];
	childPackages: string[];
	totals: Record<Complexity, number>;
}

const RANK: Record<Complexity, number> = { low: 0, medium: 1, high: 2 };

interface Rule {
	match: RegExp;
	complexity: Complexity;
	summary: string;
	note?: string;
	blocker?: boolean;
}

/** Data flow components, matched against the component kind. First match wins. */
const COMPONENT_RULES: Rule[] = [
	{ match: /script/i, complexity: "high", summary: "custom .NET code running per row", note: "Script component: the code must be read and reimplemented by hand.", blocker: true },
	{ match: /fuzzy/i, complexity: "high", summary: "fuzzy matching", note: "Fuzzy Lookup/Grouping has no SQL equivalent; needs a similarity library or a redesign.", blocker: true },
	{ match: /term(extraction|lookup)|datamining/i, complexity: "high", summary: "text mining / data mining", note: "Depends on SSIS-only text or mining engines.", blocker: true },
	{ match: /cdc/i, complexity: "high", summary: "change data capture", note: "CDC components rely on SQL Server CDC state stored by SSIS; re-plan incremental loading." },
	{ match: /excel/i, complexity: "medium", summary: "Excel workbook read/write", note: "Uses the Windows-only ACE/Jet OLE DB provider.", blocker: true },
	{ match: /scd|slowlychanging/i, complexity: "medium", summary: "slowly changing dimension logic", note: "Rewrite as a MERGE (type 1) and/or insert-and-expire (type 2); the wizard-generated flow shows which columns are which." },
	{ match: /oledbcommand/i, complexity: "medium", summary: "one SQL statement executed per row", note: "Row-by-row command: rewrite as a set-based UPDATE/DELETE/MERGE." },
	{ match: /pivot/i, complexity: "medium", summary: "pivot/unpivot", note: "Expressible with PIVOT/UNPIVOT or conditional aggregation." },
	{ match: /recordset/i, complexity: "medium", summary: "rows captured into an object variable", note: "Feeds a later Foreach loop; replace with a query the loop reads directly." },
	{ match: /rawfile|xmlsource/i, complexity: "medium", summary: "file source/destination in an SSIS-specific or XML format" },
	{ match: /flatfile/i, complexity: "low", summary: "delimited/fixed-width file read or write", note: "Column layout comes from the flat file connection manager." },
	{ match: /lookup/i, complexity: "low", summary: "lookup against a reference table", note: "Becomes a JOIN; check the no-match behaviour (fail, ignore, redirect) to choose INNER or LEFT." },
	{ match: /mergejoin|^merge$/i, complexity: "low", summary: "join/merge of two sorted inputs", note: "Becomes a JOIN or UNION ALL; the upstream Sorts exist only to satisfy SSIS." },
	{ match: /derivedcolumn|dataconver|copy(column|map)|charactermap|audit/i, complexity: "low", summary: "column expressions", note: "Translate SSIS expressions to SQL expressions." },
	{ match: /conditionalsplit/i, complexity: "low", summary: "rows routed by condition", note: "Becomes WHERE clauses, one per output." },
	{ match: /multicast|unionall|sort|aggregate|rowcount|sampling/i, complexity: "low", summary: "set operation expressible in SQL" },
	{ match: /source/i, complexity: "low", summary: "database read" },
	{ match: /destination/i, complexity: "low", summary: "database write" },
];

function classifyComponent(c: Component): Rule {
	return (
		COMPONENT_RULES.find((r) => r.match.test(c.kind)) ?? {
			match: /./,
			complexity: "high",
			summary: `unrecognised component type ${c.kind}`,
			note: "Not a built-in component (third-party or custom); find out what it does before estimating.",
			blocker: true,
		}
	);
}

function describeFlow(e: Executable): string {
	const flow = e.dataFlow!;
	const ordered = topoSort(flow.components, (c) => c.name, flow.paths.map((p) => ({ from: p.fromComponent ?? "", to: p.toComponent ?? "" })));
	return ordered.map((c) => `${c.name} [${c.kind}]`).join(" → ") || "empty data flow";
}

function taskItem(e: Executable, blockers: string[]): InventoryItem {
	const notes: string[] = [];
	let complexity: Complexity = "low";
	let summary = "";
	const raise = (c: Complexity) => {
		if (RANK[c] > RANK[complexity]) complexity = c;
	};

	switch (e.kind) {
		case "ExecuteSQL": {
			const s = e.sql!;
			summary = `${s.isStoredProc ? "calls stored procedure" : "runs SQL"} on ${s.connection ?? "an unresolved connection"}`;
			if (s.sourceType !== "DirectInput") {
				raise("medium");
				notes.push(`Statement comes from a ${s.sourceType} (${s.statement}), so the SQL is built at run time.`);
			}
			if (s.parameterBindings.length) notes.push(`${s.parameterBindings.length} parameter(s) bound from variables; OLE DB "?" markers are positional.`);
			if (s.resultBindings.length) notes.push(`Result is stored in ${s.resultBindings.map((b) => b.variable).join(", ")} and used later in the flow.`);
			if (s.resultType === "Rowset") notes.push("Returns a full result set into an object variable, typically iterated by a Foreach loop.");
			break;
		}
		case "DataFlow": {
			summary = describeFlow(e);
			for (const c of e.dataFlow!.components) {
				const rule = classifyComponent(c);
				raise(rule.complexity);
				if (rule.note && !notes.includes(`${c.name}: ${rule.note}`)) notes.push(`${c.name}: ${rule.note}`);
				if (rule.blocker) blockers.push(`${e.refId} :: ${c.name} — ${rule.note ?? rule.summary}`);
				const redirected = c.outputs.filter((o) => o.isError && e.dataFlow!.paths.some((p) => p.from === o.key));
				if (redirected.length) {
					raise("medium");
					notes.push(`${c.name}: error rows are redirected to ${redirected.map((o) => e.dataFlow!.paths.find((p) => p.from === o.key)!.toComponent).join(", ")}; reproduce the reject handling.`);
				}
			}
			if (e.dataFlow!.components.length > 12) raise("medium");
			break;
		}
		case "ExecutePackage":
			summary = `runs child package ${e.executePackage!.packageName ?? "(resolved through a connection)"}`;
			if (e.executePackage!.parameterAssignments.length) notes.push(`Passes ${e.executePackage!.parameterAssignments.map((a) => `${a.parameter} ← ${a.source}`).join(", ")}.`);
			break;
		case "Script": {
			const lines = e.script!.files.reduce((n, f) => n + f.code.split("\n").length, 0);
			summary = `custom ${e.script!.language ?? ".NET"} script, ${lines} lines`;
			complexity = "high";
			notes.push("Script task: read the code (ssis_package with detail full) and reimplement it.");
			blockers.push(`${e.refId} — script task (${lines} lines of ${e.script!.language ?? ".NET"}) must be reimplemented by hand`);
			break;
		}
		case "Expression":
			summary = `assigns a variable: ${e.expression}`;
			break;
		case "ForEachLoop": {
			const kind = e.forEach?.enumerator ?? "unknown enumerator";
			summary = `loops over ${/file/i.test(kind) ? `files matching ${e.forEach?.properties.FileSpec ?? "a pattern"}` : /ado/i.test(kind) ? "rows of a result set" : kind}`;
			complexity = "medium";
			if (/file/i.test(kind)) notes.push("File enumeration becomes a directory listing/glob in the orchestrator; check the folder is reachable from the new runtime.");
			if (/ado/i.test(kind)) notes.push("Often replaceable by a single set-based statement instead of a loop.");
			break;
		}
		case "ForLoop":
			summary = `counted loop (${e.forLoop?.eval ?? "no condition"})`;
			complexity = "medium";
			break;
		case "Sequence":
			summary = "groups tasks";
			break;
		case "EventHandler":
			summary = `runs when ${e.name} fires`;
			complexity = "medium";
			notes.push("Event handlers become failure hooks / try-catch in the target orchestrator.");
			break;
		case "FileSystem":
			summary = "file operation (copy, move, delete, create)";
			notes.push("Reimplement with the target runtime's file API; check Windows paths.");
			break;
		case "SendMail":
			summary = "sends an e-mail";
			notes.push("Replace with the target platform's alerting.");
			break;
		case "ExecuteProcess":
			summary = `runs an external program (${e.taskProperties?.Executable ?? "?"})`;
			complexity = "medium";
			notes.push("The executable must exist on the new runtime.");
			break;
		case "FTP":
		case "WebService":
		case "XML":
		case "BulkInsert":
			summary = `${e.kind} task`;
			complexity = "medium";
			break;
		default:
			summary = `unrecognised task type ${e.type.split(",")[0]}`;
			complexity = "high";
			notes.push("Not a task this tool knows (possibly third-party); find out what it does before estimating.");
			blockers.push(`${e.refId} — unrecognised task type ${e.type.split(",")[0]}`);
	}

	if (e.disabled) notes.push("Disabled in the package: confirm whether it should be migrated at all.");
	if (e.properties.TransactionOption === "Required") {
		raise("medium");
		notes.push("TransactionOption=Required: SSIS wraps this in a distributed (MSDTC) transaction; decide how atomicity is kept.");
	}
	if (Object.keys(e.expressions).length) notes.push(`Properties set by expression at run time: ${Object.keys(e.expressions).join(", ")}.`);
	return { where: e.refId, kind: e.kind, name: e.name, summary, complexity, notes };
}

function connectionNotes(c: Connection): string[] {
	const notes: string[] = [];
	const type = c.type.toUpperCase();
	const text = c.connectionString ?? "";
	if (/EXCEL|ACE\.OLEDB|JET\.OLEDB/i.test(`${type} ${text}`)) notes.push("Excel/Access via ACE/Jet: Windows-only provider.");
	if (/SQLNCLI/i.test(text)) notes.push("Uses the deprecated SQL Server Native Client provider.");
	if (/Integrated Security\s*=\s*(SSPI|True)/i.test(text)) notes.push("Windows integrated authentication: the new runtime needs its own identity or stored credentials.");
	if (/^[A-Za-z]:\\|^\\\\/.test(text) || /Data Source\s*=\s*([A-Za-z]:\\|\\\\)/i.test(text)) notes.push("Points at a Windows drive or UNC path.");
	if (/SMTP|FTP|HTTP|MSMQ|WMI|MSOLAP/.test(type)) notes.push(`${c.type} connection: needs an equivalent client in the target stack.`);
	if (Object.keys(c.expressions).length) notes.push(`Built at run time from expressions on ${Object.keys(c.expressions).join(", ")}.`);
	return notes;
}

export function buildInventory(pkg: Package): Inventory {
	const blockers: string[] = [];
	const items: InventoryItem[] = [];
	const childPackages = new Set<string>();
	walk(pkg.root, (e) => {
		if (e.kind === "Package") return;
		items.push(taskItem(e, blockers));
		if (e.executePackage?.packageName) childPackages.add(e.executePackage.packageName);
	});

	const considerations: string[] = [];
	const expressionVariables = pkg.root.variables.filter((v) => v.expression !== undefined).length;
	if (pkg.configurations.length) considerations.push(`${pkg.configurations.length} legacy package configuration(s) (${pkg.configurations.map((c) => c.type).join(", ")}) supply settings from outside the package.`);
	if (pkg.parameters.length) considerations.push(`Package parameters to carry over as job/run arguments: ${pkg.parameters.map((p) => p.name).join(", ")}.`);
	if (expressionVariables) considerations.push(`${expressionVariables} variable(s) are computed with the SSIS expression language and need translating.`);
	if (pkg.protectionLevel.startsWith("Encrypt")) considerations.push(`Protection level ${pkg.protectionLevel}: stored secrets are not readable here and must be re-supplied.`);
	if (pkg.logProviders.length) considerations.push(`Custom log providers (${pkg.logProviders.join(", ")}) need a logging equivalent.`);
	if (pkg.formatVersion && pkg.formatVersion < 6) considerations.push(`Legacy package format ${pkg.formatVersion} (SSIS 2005/2008).`);
	for (const w of pkg.warnings) considerations.push(`Could not fully read: ${w}`);

	const totals: Record<Complexity, number> = { low: 0, medium: 0, high: 0 };
	for (const i of items) totals[i.complexity]++;

	return {
		package: pkg.name,
		items,
		connections: pkg.connections.map((c) => ({ name: c.name, type: c.type, notes: connectionNotes(c) })),
		blockers,
		considerations,
		childPackages: [...childPackages],
		totals,
	};
}

export function renderInventory(inv: Inventory): string {
	const out = [`# Migration inventory: ${inv.package}`, `${inv.items.length} tasks — ${inv.totals.low} low, ${inv.totals.medium} medium, ${inv.totals.high} high complexity`];
	if (inv.blockers.length) out.push("", "## Needs manual work", ...inv.blockers.map((b) => `- ${b}`));
	if (inv.considerations.length) out.push("", "## Package-level considerations", ...inv.considerations.map((c) => `- ${c}`));
	if (inv.connections.length) {
		out.push("", "## Connections");
		for (const c of inv.connections) out.push(`- ${c.name} [${c.type}]${c.notes.length ? `: ${c.notes.join(" ")}` : ""}`);
	}
	if (inv.childPackages.length) out.push("", `Runs child packages: ${inv.childPackages.join(", ")}`);
	out.push("", "## Tasks");
	for (const i of inv.items) {
		out.push(`- [${i.complexity}] ${i.where} (${i.kind}): ${i.summary}`);
		for (const n of i.notes) out.push(`    ${n}`);
	}
	return out.join("\n");
}

export function renderProjectInventory(project: Project): string {
	const inventories = project.packages.filter((p) => p.package).map((p) => ({ file: p.file, inv: buildInventory(p.package!) }));
	const totals: Record<Complexity, number> = { low: 0, medium: 0, high: 0 };
	for (const { inv } of inventories) for (const k of Object.keys(totals) as Complexity[]) totals[k] += inv.totals[k];
	const calls = inventories.flatMap(({ file, inv }) => inv.childPackages.map((c) => ({ from: file, to: c })));
	// Children first: a package can only be cut over once what it calls exists.
	const order = topoSort(inventories, (i) => i.file, calls.map((c) => ({ from: c.to, to: c.from })));

	const out = [
		`# Migration inventory: project ${project.name ?? project.root}`,
		`${inventories.length} packages, ${totals.low + totals.medium + totals.high} tasks — ${totals.low} low, ${totals.medium} medium, ${totals.high} high complexity`,
		"",
		"## Packages, in suggested migration order (called packages before their callers)",
	];
	for (const { file, inv } of order) {
		out.push(`- ${file}: ${inv.totals.low} low / ${inv.totals.medium} medium / ${inv.totals.high} high${inv.blockers.length ? `, ${inv.blockers.length} manual item(s)` : ""}${inv.childPackages.length ? `, runs ${inv.childPackages.join(", ")}` : ""}`);
	}
	const unreadable = project.packages.filter((p) => !p.package);
	if (unreadable.length) out.push("", "## Unreadable packages", ...unreadable.map((p) => `- ${p.file}: ${p.error}`));
	if (project.parameters.length) out.push("", `Project parameters to carry over: ${project.parameters.map((p) => p.name).join(", ")}`);
	const blockers = order.flatMap(({ file, inv }) => inv.blockers.map((b) => `- ${file}: ${b}`));
	if (blockers.length) out.push("", "## Needs manual work", ...blockers);
	out.push("", "Run ssis_migration_inventory on a single package for task-level detail.");
	return out.join("\n");
}
