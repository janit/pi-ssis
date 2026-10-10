import type { Connection, Constraint, Executable, Package, Parameter, Variable } from "../dtsx/model.ts";
import type { Project } from "../dtsx/project.ts";
import { walk } from "../dtsx/model.ts";
import { field, indent, topoSort, truncate } from "./text.ts";

export interface RenderOptions {
	/** "outline" shortens long SQL and omits script source; "full" prints everything. */
	detail?: "outline" | "full";
}

const OUTLINE_SQL = 400;

function limit(options: RenderOptions): number {
	return options.detail === "full" ? Number.POSITIVE_INFINITY : OUTLINE_SQL;
}

export function renderConnection(c: Connection): string {
	const lines = [`- ${c.name} [${c.type || "unknown"}${c.scope === "project" ? ", project" : ""}]${c.connectionString ? ` ${c.connectionString}` : ""}`];
	for (const [name, expr] of Object.entries(c.expressions)) lines.push(`    ${name} = ${expr}  (expression)`);
	const props = Object.entries(c.properties).filter(([k]) => !/^(LocaleID|CodePage|Unicode|DTSID|CreationName)$/.test(k));
	if (props.length && c.type.toUpperCase().includes("FLATFILE")) {
		lines.push(`    ${props.map(([k, v]) => `${k}=${v}`).join(", ")}`);
	}
	if (c.flatFileColumns?.length) {
		lines.push(`    columns: ${c.flatFileColumns.map((col) => `${col.name} ${col.dataType}${col.width && col.width !== "0" ? `(${col.width})` : ""}`).join(", ")}`);
	}
	return lines.join("\n");
}

export function renderParameter(p: Parameter): string {
	const flags = [p.required ? "required" : "", p.sensitive ? "sensitive" : ""].filter(Boolean).join(", ");
	const prefix = p.scope === "project" ? "$Project" : "$Package";
	return `- ${prefix}::${p.name} ${p.dataType}${p.value !== undefined ? ` = ${JSON.stringify(p.value)}` : ""}${flags ? ` (${flags})` : ""}${p.description ? ` — ${p.description}` : ""}`;
}

function renderVariable(v: Variable): string {
	const value = v.expression !== undefined ? `expression: ${v.expression}` : v.value !== undefined ? `= ${JSON.stringify(v.value)}` : "";
	return `- ${v.namespace}::${v.name} ${v.dataType} ${value}${v.readOnly ? " (read-only)" : ""}`.trimEnd();
}

function describeConstraint(c: Constraint, name: (ref: string) => string): string {
	const parts: string[] = [];
	if (c.evalOp !== "Expression") parts.push(c.value);
	if (c.expression) {
		const joiner = c.evalOp === "ExpressionOrConstraint" ? "or" : "and";
		parts.push(c.evalOp === "Expression" ? `when ${c.expression}` : `${joiner} ${c.expression}`);
	}
	return `${name(c.from)} (${parts.join(" ")})`;
}

function taskLines(e: Executable, options: RenderOptions): string[] {
	const lines: string[] = [];
	const max = limit(options);
	if (e.description && e.description !== e.name && !/ Task$| Container$/.test(e.description)) lines.push(`note: ${e.description}`);
	for (const [k, v] of Object.entries(e.properties)) lines.push(`${k}: ${v}`);
	for (const [k, v] of Object.entries(e.expressions)) lines.push(field(`expression ${k}`, v, max));

	if (e.sql) {
		const s = e.sql;
		lines.push(`connection: ${s.connection ?? s.connectionRef ?? "(none)"}`);
		const label = s.isStoredProc ? "stored procedure" : s.sourceType === "DirectInput" ? "sql" : `sql (from ${s.sourceType})`;
		lines.push(field(label, s.statement, max));
		if (s.parameterBindings.length) {
			lines.push(`parameters: ${s.parameterBindings.map((b) => `${b.name} ${b.direction === "Input" ? "←" : `(${b.direction}) ↔`} ${b.variable}`).join(", ")}`);
		}
		if (s.resultType !== "None") {
			lines.push(`result (${s.resultType}): ${s.resultBindings.map((b) => `${b.name} → ${b.variable}`).join(", ") || "(unbound)"}`);
		}
	}
	if (e.executePackage) {
		const x = e.executePackage;
		lines.push(`runs package: ${x.packageName ?? "(via connection " + (x.connection ?? "?") + ")"}${x.useProjectReference ? " (project reference)" : ""}`);
		for (const a of x.parameterAssignments) lines.push(`  child parameter ${a.parameter} ← ${a.source}`);
	}
	if (e.script) {
		const s = e.script;
		lines.push(`script (${s.language ?? "unknown language"})${s.readOnlyVariables.length ? ` reads: ${s.readOnlyVariables.join(", ")}` : ""}${s.readWriteVariables.length ? ` writes: ${s.readWriteVariables.join(", ")}` : ""}`);
		for (const f of s.files) {
			if (options.detail === "full") lines.push(field(f.name, f.code));
			else lines.push(`${f.name}: ${f.code.split("\n").length} lines (detail "full" shows the code)`);
		}
	}
	if (e.expression !== undefined) lines.push(field("expression", e.expression, max));
	if (e.forLoop) {
		lines.push(`for (${e.forLoop.init ?? ""}; ${e.forLoop.eval ?? ""}; ${e.forLoop.assign ?? ""})`);
	}
	if (e.forEach) {
		const props = Object.entries(e.forEach.properties).map(([k, v]) => `${k}=${truncate(v, 200)}`);
		lines.push(`foreach ${e.forEach.enumerator}${props.length ? `: ${props.join(", ")}` : ""}`);
		if (e.forEach.variableMappings.length) {
			lines.push(`each item → ${e.forEach.variableMappings.map((m) => `[${m.index}] ${m.variable}`).join(", ")}`);
		}
	}
	if (e.dataFlow) {
		const flow = e.dataFlow;
		const ordered = topoSort(
			flow.components,
			(c) => c.name,
			flow.paths.map((p) => ({ from: p.fromComponent ?? "", to: p.toComponent ?? "" })),
		);
		lines.push(`data flow, ${flow.components.length} components: ${ordered.map((c) => `${c.name} [${c.kind}]`).join(" → ") || "(empty)"}`);
		if (flow.components.length) lines.push(`(ssis_dataflow shows columns, mappings and component settings)`);
	}
	if (e.taskProperties) {
		for (const [k, v] of Object.entries(e.taskProperties)) lines.push(field(k, v, max));
	}
	return lines;
}

function renderExecutable(e: Executable, siblings: Executable[], constraints: Constraint[], options: RenderOptions): string {
	const nameOf = (ref: string) => siblings.find((s) => s.refId === ref)?.name ?? ref;
	const head = `- [${e.kind === "Other" ? e.type.split(",")[0] : e.kind}] ${e.name}${e.disabled ? "  (DISABLED)" : ""}`;
	const body: string[] = [];
	const incoming = constraints.filter((c) => c.to === e.refId);
	if (incoming.length) {
		const joiner = incoming.some((c) => !c.logicalAnd) ? " OR " : " AND ";
		body.push(`after: ${incoming.map((c) => describeConstraint(c, nameOf)).join(joiner)}`);
	}
	body.push(...taskLines(e, options));
	if (e.variables.length && e.kind !== "Package") {
		body.push("variables:", ...e.variables.map((v) => `  ${renderVariable(v)}`));
	}
	const parts = [head];
	if (body.length) parts.push(indent(body.join("\n"), "    "));
	if (e.children.length) parts.push(indent(renderChildren(e, options), "    "));
	for (const h of e.eventHandlers) {
		parts.push(indent(`on ${h.name}:\n${indent(renderChildren(h, options) || "(empty)", "  ")}`, "    "));
	}
	return parts.join("\n");
}

function renderChildren(container: Executable, options: RenderOptions): string {
	const ordered = topoSort(container.children, (c) => c.refId, container.constraints);
	return ordered.map((c) => renderExecutable(c, container.children, container.constraints, options)).join("\n");
}

export function renderPackage(pkg: Package, options: RenderOptions = {}): string {
	const out: string[] = [];
	out.push(`# Package ${pkg.name}`);
	out.push(`format ${pkg.formatVersion}, protection level ${pkg.protectionLevel}${pkg.description ? `\n${pkg.description}` : ""}`);
	if (pkg.formatVersion && pkg.formatVersion < 6) {
		out.push("Legacy (SSIS 2005/2008) format: readable, but ssis_edit only supports format 6+ (SSIS 2012 and later).");
	}

	if (pkg.connections.length) out.push("", "## Connections", ...pkg.connections.map(renderConnection));
	if (pkg.parameters.length) out.push("", "## Parameters", ...pkg.parameters.map(renderParameter));
	if (pkg.root.variables.length) out.push("", "## Variables", ...pkg.root.variables.map(renderVariable));
	if (pkg.configurations.length) {
		out.push("", "## Package configurations (legacy)", ...pkg.configurations.map((c) => `- ${c.name} [${c.type}] ${c.source ?? ""}${c.target ? ` → ${c.target}` : ""}`));
	}
	if (Object.keys(pkg.root.properties).length || Object.keys(pkg.root.expressions).length) {
		out.push("", "## Package settings");
		for (const [k, v] of Object.entries(pkg.root.properties)) out.push(`- ${k}: ${v}`);
		for (const [k, v] of Object.entries(pkg.root.expressions)) out.push(`- expression ${k} = ${v}`);
	}

	out.push("", "## Control flow", "Tasks are listed in execution order. Address a task by name, or by refId: container names joined with \\ starting at Package (e.g. Package\\My Sequence\\My Task).");
	out.push(renderChildren(pkg.root, options) || "(no tasks)");

	if (pkg.root.eventHandlers.length) {
		out.push("", "## Event handlers");
		for (const h of pkg.root.eventHandlers) out.push(`on ${h.name}:`, indent(renderChildren(h, options) || "(empty)", "  "));
	}
	if (pkg.logProviders.length) out.push("", `Log providers: ${pkg.logProviders.join(", ")}`);
	if (pkg.warnings.length) out.push("", "## Warnings", ...pkg.warnings.map((w) => `- ${w}`));
	return out.join("\n");
}

export function renderProject(project: Project): string {
	const out: string[] = [];
	out.push(`# SSIS project ${project.name ?? "(unnamed)"}`);
	out.push(`${project.kind === "ispac" ? "deployment file" : "directory"}: ${project.root}${project.protectionLevel ? `, protection level ${project.protectionLevel}` : ""}`);
	if (project.connections.length) out.push("", "## Project connections", ...project.connections.map(renderConnection));
	if (project.parameters.length) out.push("", "## Project parameters", ...project.parameters.map(renderParameter));

	out.push("", `## Packages (${project.packages.length})`);
	if (!project.packages.length) out.push("No .dtsx files found.");
	for (const entry of project.packages) {
		if (!entry.package) {
			out.push(`- ${entry.file}: UNREADABLE — ${entry.error}`);
			continue;
		}
		const pkg = entry.package;
		const counts = new Map<string, number>();
		const calls = new Set<string>();
		const used = new Set<string>();
		walk(pkg.root, (e) => {
			if (e.kind !== "Package") counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
			if (e.executePackage?.packageName) calls.add(e.executePackage.packageName);
			if (e.sql?.connection) used.add(e.sql.connection);
			for (const c of e.dataFlow?.components ?? []) for (const conn of c.connections) if (conn.manager) used.add(conn.manager);
		});
		const summary = [...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "empty";
		out.push(`- ${entry.file}: ${summary}`);
		if (pkg.parameters.length) out.push(`    parameters: ${pkg.parameters.map((p) => p.name).join(", ")}`);
		if (used.size) out.push(`    connections used: ${[...used].join(", ")}`);
		if (calls.size) out.push(`    runs packages: ${[...calls].join(", ")}`);
		if (pkg.formatVersion && pkg.formatVersion < 6) out.push(`    legacy format ${pkg.formatVersion}`);
	}
	return out.join("\n");
}
