import { collectFacts } from "../dtsx/facts.ts";
import { allVariables, type Executable, type Package, walk } from "../dtsx/model.ts";
import { parsePackage, type ParseOptions } from "../dtsx/parse.ts";
import { descendants, findAttr, parseXml } from "../dtsx/xml.ts";

export interface Issue {
	severity: "error" | "warning";
	where: string;
	message: string;
}

function duplicates(values: string[]): string[] {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const v of values) {
		const k = v.toLowerCase();
		if (seen.has(k)) dupes.add(v);
		seen.add(k);
	}
	return [...dupes];
}

function findCycle(container: Executable): string[] | undefined {
	const next = new Map<string, string[]>();
	for (const c of container.constraints) next.set(c.from, [...(next.get(c.from) ?? []), c.to]);
	const state = new Map<string, number>();
	const visit = (node: string, trail: string[]): string[] | undefined => {
		if (state.get(node) === 1) return [...trail.slice(trail.indexOf(node)), node];
		if (state.get(node) === 2) return undefined;
		state.set(node, 1);
		for (const n of next.get(node) ?? []) {
			const found = visit(n, [...trail, node]);
			if (found) return found;
		}
		state.set(node, 2);
		return undefined;
	};
	for (const node of next.keys()) {
		const found = visit(node, []);
		if (found) return found;
	}
	return undefined;
}

export interface ValidateOptions extends ParseOptions {
	/** Names of project parameters, when the project is known. */
	projectParameters?: string[];
}

/**
 * Structural checks only: ids, references and graph shape. This cannot tell
 * whether a package will run; it catches the mistakes that stop it loading.
 */
export function validatePackage(source: string, options: ValidateOptions = {}): { issues: Issue[]; package?: Package } {
	const issues: Issue[] = [];
	let pkg: Package;
	try {
		pkg = parsePackage(source, options);
	} catch (error) {
		return { issues: [{ severity: "error", where: "Package", message: (error as Error).message }] };
	}
	const error = (where: string, message: string) => issues.push({ severity: "error", where, message });
	const warning = (where: string, message: string) => issues.push({ severity: "warning", where, message });

	// Identity
	const doc = parseXml(source);
	const ids: string[] = [];
	const refIds: string[] = [];
	const collect = (el: Parameters<Parameters<typeof descendants>[1]>[0]) => {
		if (el.local === "DesignTimeProperties") return;
		const id = findAttr(el, "DTSID");
		if (id && el.prefix === "DTS") ids.push(id.value);
		const refId = findAttr(el, "refId");
		if (refId) refIds.push(refId.value);
	};
	collect(doc.root);
	descendants(doc.root, collect);
	for (const d of duplicates(ids)) error("Package", `Duplicate DTSID ${d}`);
	for (const d of duplicates(refIds)) error("Package", `Duplicate refId ${d}`);

	for (const d of duplicates(pkg.connections.filter((c) => c.scope === "package").map((c) => c.name))) {
		error("Connections", `Duplicate connection manager name "${d}"`);
	}
	for (const d of duplicates(pkg.parameters.map((p) => p.name))) error("Parameters", `Duplicate parameter name "${d}"`);

	walk(pkg.root, (e) => {
		for (const d of duplicates(e.children.map((c) => c.name))) error(e.refId, `Two tasks named "${d}" in the same container`);
		for (const d of duplicates(e.variables.map((v) => `${v.namespace}::${v.name}`))) error(e.refId, `Duplicate variable ${d}`);

		const children = new Set(e.children.map((c) => c.refId));
		for (const c of e.constraints) {
			if (!children.has(c.from)) error(e.refId, `Precedence constraint "${c.name}" starts at "${c.from}", which is not a task in this container`);
			if (!children.has(c.to)) error(e.refId, `Precedence constraint "${c.name}" ends at "${c.to}", which is not a task in this container`);
			if (c.from === c.to) error(e.refId, `Precedence constraint "${c.name}" connects "${c.from}" to itself`);
		}
		const cycle = findCycle(e);
		if (cycle) error(e.refId, `Precedence constraints form a cycle: ${cycle.join(" → ")}`);

		if (e.sql) {
			if (!e.sql.connectionRef) warning(e.refId, "Execute SQL task has no connection");
			else if (!e.sql.connection) warning(e.refId, `Connection ${e.sql.connectionRef} is not defined in this package (it may be a project connection manager that was not found next to the package)`);
			if (!e.sql.statement.trim()) warning(e.refId, "Execute SQL task has an empty statement");
		}

		if (e.dataFlow) {
			const outputColumns = new Set<string>();
			for (const c of e.dataFlow.components) for (const o of c.outputs) for (const col of o.columns) outputColumns.add(col.key);
			for (const d of duplicates(e.dataFlow.components.map((c) => c.name))) error(e.refId, `Two components named "${d}"`);
			for (const p of e.dataFlow.paths) {
				if (!p.fromComponent) error(e.refId, `Data flow path "${p.name}" starts at unknown output ${p.from}`);
				if (!p.toComponent) error(e.refId, `Data flow path "${p.name}" ends at unknown input ${p.to}`);
			}
			for (const c of e.dataFlow.components) {
				for (const conn of c.connections) {
					if (conn.ref && !conn.manager) warning(`${e.refId} :: ${c.name}`, `Connection manager ${conn.ref} was not found`);
				}
				for (const i of c.inputs) {
					for (const col of i.columns) {
						if (col.lineage && !outputColumns.has(col.lineage)) {
							error(`${e.refId} :: ${c.name}`, `Input column "${col.name}" refers to upstream column ${col.lineage}, which does not exist`);
						}
					}
				}
			}
		}
	});

	// Variable and parameter references inside expressions, SQL bindings and settings.
	const variables = allVariables(pkg);
	const known = new Set(variables.map((v) => `${v.namespace}::${v.name}`.toLowerCase()));
	for (const p of pkg.parameters) known.add(`$package::${p.name}`.toLowerCase());
	for (const p of options.projectParameters ?? []) known.add(`$project::${p}`.toLowerCase());
	const namespaces = new Set(["User", "$Package", ...variables.map((v) => v.namespace)]);
	if (options.projectParameters) namespaces.add("$Project");
	namespaces.delete("System");
	const pattern = new RegExp(`(?<![\\w$])(${[...namespaces].map((n) => n.replace(/\$/g, "\\$")).join("|")})::(\\w+)`, "g");
	const reported = new Set<string>();
	for (const fact of collectFacts(pkg)) {
		if (fact.field.startsWith("script ") || fact.where.startsWith("Variable ") || fact.where.startsWith("Parameter ")) {
			if (fact.field !== "expression") continue;
		}
		for (const match of fact.text.matchAll(pattern)) {
			const ref = `${match[1]}::${match[2]}`;
			const key = `${fact.where}|${ref}`.toLowerCase();
			if (known.has(ref.toLowerCase()) || reported.has(key)) continue;
			reported.add(key);
			warning(fact.where, `${fact.field} refers to ${ref}, which is not declared`);
		}
	}

	for (const w of pkg.warnings) warning("Package", w);
	return { issues, package: pkg };
}

export function renderIssues(issues: Issue[]): string {
	if (!issues.length) return "No structural problems found.";
	const errors = issues.filter((i) => i.severity === "error");
	const warnings = issues.filter((i) => i.severity === "warning");
	const lines = [`${errors.length} error(s), ${warnings.length} warning(s)`];
	for (const i of [...errors, ...warnings]) lines.push(`- ${i.severity.toUpperCase()} ${i.where}: ${i.message}`);
	return lines.join("\n");
}
