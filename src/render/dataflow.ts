import type { Column, Component, Executable, Port } from "../dtsx/model.ts";
import type { RenderOptions } from "./package.ts";
import { field, indent, topoSort } from "./text.ts";

/** Properties that are bookkeeping rather than behaviour. */
const HIDDEN = new Set([
	"CommandTimeout",
	"DefaultCodePage",
	"AlwaysUseDefaultCodePage",
	"UserComponentTypeName",
	"VSTAProjectName",
	"BinaryCode",
	"LocaleID",
	"MetadataChecksum",
	"TypeConverter",
	"UITypeEditor",
]);

const SOURCE_ACCESS = ["table or view", "table name from variable", "SQL command", "SQL command from variable"];
const DEST_ACCESS = ["table or view", "table name from variable", "SQL command", "table or view (fast load)", "table name from variable (fast load)"];

const JOIN_TYPES = ["full outer", "left outer", "inner"];

const COLUMN_PROPS = ["JoinToReferenceColumn", "CopyFromReferenceColumn", "AggregationType", "NewSortKeyPosition", "NewComparisonFlags", "FastParse"];

const MAX_COLUMNS = 80;

function accessMode(c: Component, value: string): string {
	const names = c.outputs.some((o) => !o.isError) && !c.inputs.length ? SOURCE_ACCESS : DEST_ACCESS;
	return names[Number(value)] ? `${value} (${names[Number(value)]})` : value;
}

function columnText(col: Column): string {
	const expr = col.properties.FriendlyExpression ?? col.properties.Expression;
	const extras = COLUMN_PROPS.filter((p) => col.properties[p] !== undefined && col.properties[p] !== "0").map((p) => `${p}=${col.properties[p]}`);
	return `${col.name}${col.dataType ? ` ${col.dataType}` : ""}${expr ? ` = ${expr}` : ""}${extras.length ? ` {${extras.join(", ")}}` : ""}`;
}

function listColumns(columns: Column[], render: (c: Column) => string): string {
	const shown = columns.slice(0, MAX_COLUMNS).map(render).join(", ");
	return columns.length > MAX_COLUMNS ? `${shown}, … +${columns.length - MAX_COLUMNS} more` : shown;
}

function renderInput(port: Port, lines: string[]): void {
	if (!port.columns.length) return;
	const external = new Map(port.externalColumns.map((c) => [c.key, c.name]));
	const mapped = port.columns.filter((c) => c.externalColumn && external.has(c.externalColumn));
	if (mapped.length) {
		lines.push(`maps: ${listColumns(mapped, (c) => {
			const target = external.get(c.externalColumn!)!;
			return target === c.name ? c.name : `${c.name} → ${target}`;
		})}`);
		const unmapped = port.externalColumns.filter((e) => !mapped.some((m) => m.externalColumn === e.key));
		if (unmapped.length) lines.push(`unmapped destination columns: ${listColumns(unmapped, (c) => c.name)}`);
		return;
	}
	const interesting = port.columns.filter(
		(c) => c.usage === "readWrite" || c.properties.FriendlyExpression || COLUMN_PROPS.some((p) => c.properties[p] !== undefined && c.properties[p] !== "0"),
	);
	if (interesting.length) lines.push(`input "${port.name}" uses: ${listColumns(interesting, columnText)}`);
	else lines.push(`input "${port.name}": ${listColumns(port.columns, (c) => c.name)}`);
}

function renderComponent(c: Component, flow: Executable, options: RenderOptions, index: number): string {
	const max = options.detail === "full" ? Number.POSITIVE_INFINITY : 600;
	const paths = flow.dataFlow!.paths;
	const lines: string[] = [];

	const upstream = paths.filter((p) => p.toComponent === c.name);
	if (upstream.length) lines.push(`from: ${upstream.map((p) => `${p.fromComponent} (${p.fromOutput})`).join(", ")}`);
	for (const conn of c.connections) lines.push(`connection: ${conn.manager ?? conn.ref}`);

	for (const [name, value] of Object.entries(c.properties)) {
		if (HIDDEN.has(name)) continue;
		if (name === "AccessMode") lines.push(`AccessMode: ${accessMode(c, value)}`);
		else if (name === "JoinType" && JOIN_TYPES[Number(value)]) lines.push(`JoinType: ${JOIN_TYPES[Number(value)]}`);
		else if (value === "false" || value === "0") continue;
		else lines.push(field(name, value, max));
	}
	if (c.script) {
		lines.push(`script (${c.script.language ?? "unknown language"})`);
		for (const f of c.script.files) {
			if (options.detail === "full") lines.push(field(f.name, f.code));
			else lines.push(`${f.name}: ${f.code.split("\n").length} lines (detail "full" shows the code)`);
		}
	}

	for (const port of c.inputs) renderInput(port, lines);

	for (const port of c.outputs) {
		const connected = paths.filter((p) => p.from === port.key);
		if (port.isError && !connected.length) continue;
		const condition = port.properties.FriendlyExpression ?? port.properties.Expression;
		const created = port.columns;
		let line = `output "${port.name}"${port.isError ? " (error rows)" : ""}`;
		if (condition) line += ` when ${condition}`;
		if (created.length) line += `: ${listColumns(created, columnText)}`;
		if (connected.length) line += `\n    → ${connected.map((p) => p.toComponent).join(", ")}`;
		lines.push(line);
	}

	return `${index}. ${c.name} [${c.kind}]\n${indent(lines.join("\n"), "   ")}`;
}

export function renderDataFlow(flow: Executable, options: RenderOptions = {}): string {
	const pipeline = flow.dataFlow;
	if (!pipeline) return `${flow.refId} is a ${flow.kind} task, not a data flow.`;
	const ordered = topoSort(
		pipeline.components,
		(c) => c.name,
		pipeline.paths.map((p) => ({ from: p.fromComponent ?? "", to: p.toComponent ?? "" })),
	);
	const out = [`# Data flow ${flow.refId}`, `${pipeline.components.length} components, listed upstream to downstream. Column types use SSIS names (wstr = Unicode string, i4 = 32-bit int, dbTimeStamp = datetime).`, ""];
	if (!ordered.length) out.push("(no components)");
	ordered.forEach((c, i) => out.push(renderComponent(c, flow, options, i + 1)));
	return out.join("\n");
}
