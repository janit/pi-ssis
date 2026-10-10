import type { Column, Component, Connection, Path, Pipeline, Port, ScriptTask } from "./model.ts";
import { attr, child, childElements, text, type XElement } from "./xml.ts";

function key(el: XElement): string {
	return attr(el, "refId") ?? attr(el, "id") ?? "";
}

function propertyValue(el: XElement): string {
	const array = child(el, "arrayElements");
	if (array) return childElements(array, "arrayElement").map((e) => text(e)).join("\n");
	return text(el);
}

function properties(el: XElement): { values: Record<string, string>; raw: Map<string, XElement> } {
	const values: Record<string, string> = {};
	const raw = new Map<string, XElement>();
	const container = child(el, "properties");
	for (const p of container ? childElements(container, "property") : []) {
		const name = attr(p, "name");
		if (!name) continue;
		raw.set(name, p);
		const value = propertyValue(p);
		if (value !== "") values[name] = value;
	}
	return { values, raw };
}

function dataType(el: XElement): string | undefined {
	const type = attr(el, "dataType") ?? attr(el, "cachedDataType");
	if (!type) return undefined;
	const length = attr(el, "length") ?? attr(el, "cachedLength");
	const precision = attr(el, "precision") ?? attr(el, "cachedPrecision");
	const scale = attr(el, "scale") ?? attr(el, "cachedScale");
	if (length && length !== "0") return `${type}(${length})`;
	if (precision && precision !== "0") return `${type}(${precision}${scale && scale !== "0" ? `,${scale}` : ""})`;
	return type;
}

function column(el: XElement): Column {
	return {
		key: key(el),
		name: attr(el, "name") || attr(el, "cachedName") || "",
		dataType: dataType(el),
		properties: properties(el).values,
		externalColumn: attr(el, "externalMetadataColumnId"),
		lineage: el.local === "inputColumn" ? attr(el, "lineageId") : undefined,
		usage: attr(el, "usageType"),
	};
}

function port(el: XElement, columnsTag: string, columnTag: string): Port {
	const columns = child(el, columnsTag);
	const external = child(el, "externalMetadataColumns");
	return {
		key: key(el),
		name: attr(el, "name") ?? "",
		isError: attr(el, "isErrorOut") === "true",
		properties: properties(el).values,
		columns: columns ? childElements(columns, columnTag).map(column) : [],
		externalColumns: external ? childElements(external, "externalMetadataColumn").map(column) : [],
	};
}

const MANAGED_KINDS: Record<string, string> = {
	ScriptComponentHost: "ScriptComponent",
	DataReaderSourceAdapter: "ADONETSource",
	ADONETDestination: "ADONETDestination",
};

function componentKind(el: XElement, props: Record<string, string>): string {
	const classId = attr(el, "componentClassID") ?? "";
	const managed = props.UserComponentTypeName;
	if (managed) {
		const short = managed.split(",")[0]!.split(".").pop()!;
		return MANAGED_KINDS[short] ?? short;
	}
	if (classId && !classId.startsWith("{")) return classId.replace(/^(Microsoft|DTSAdapter|DTSTransform)\./, "").replace(/\.\d+$/, "");
	// Pre-2012 packages identify components by CLSID; the contact info carries the readable name.
	const contact = (attr(el, "contactInfo") ?? "").split(";")[0]!.trim();
	return (contact || attr(el, "description") || classId).replace(/\s+/g, "");
}

function scriptFromSourceCode(el: XElement | undefined, props: Record<string, string>): ScriptTask | undefined {
	if (!el) return undefined;
	const array = child(el, "arrayElements");
	if (!array) return undefined;
	const parts = childElements(array, "arrayElement").map((e) => text(e));
	const files: ScriptTask["files"] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const name = parts[i]!.trim();
		if (!/\.(cs|vb)$/i.test(name) || /(assemblyinfo|\.designer|resources|settings|buffer|component)wrapper\.(cs|vb)$|assemblyinfo\.(cs|vb)$|\.designer\.(cs|vb)$/i.test(name)) continue;
		files.push({ name, code: parts[i + 1]!.trim() });
	}
	const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	return {
		language: props.ScriptLanguage,
		readOnlyVariables: list(props.ReadOnlyVariables),
		readWriteVariables: list(props.ReadWriteVariables),
		files,
	};
}

function resolveManager(ref: string, connections: Connection[]): string | undefined {
	const bare = ref.replace(/:external$/i, "").toLowerCase();
	for (const c of connections) {
		if (c.id.toLowerCase() === bare || c.refId?.toLowerCase() === bare) return c.name;
	}
	return /ConnectionManagers\[(.+)\]$/.exec(ref)?.[1];
}

export function parsePipeline(data: XElement, connections: Connection[]): Pipeline {
	const componentsEl = child(data, "components");
	const components: Component[] = [];
	const portOwner = new Map<string, { component: string; port: string }>();

	for (const el of componentsEl ? childElements(componentsEl, "component") : []) {
		const { values, raw } = properties(el);
		const script = scriptFromSourceCode(raw.get("SourceCode"), values);
		if (script) delete values.SourceCode;
		const conns = child(el, "connections");
		const inputs = child(el, "inputs");
		const outputs = child(el, "outputs");
		const component: Component = {
			key: key(el),
			name: attr(el, "name") ?? "",
			classId: attr(el, "componentClassID") ?? "",
			kind: componentKind(el, values),
			description: attr(el, "description") || undefined,
			properties: values,
			script,
			connections: (conns ? childElements(conns, "connection") : []).map((c) => {
				const ref = attr(c, "connectionManagerRefId") ?? attr(c, "connectionManagerID") ?? "";
				return {
					name: attr(c, "name") ?? "",
					ref,
					manager: resolveManager(attr(c, "connectionManagerID") ?? "", connections) ?? resolveManager(ref, connections),
				};
			}),
			inputs: (inputs ? childElements(inputs, "input") : []).map((i) => port(i, "inputColumns", "inputColumn")),
			outputs: (outputs ? childElements(outputs, "output") : []).map((o) => port(o, "outputColumns", "outputColumn")),
		};
		for (const p of [...component.inputs, ...component.outputs]) {
			portOwner.set(p.key, { component: component.name, port: p.name });
		}
		components.push(component);
	}

	// Input columns carry only a lineage reference; give them the upstream column's name.
	const outputColumns = new Map<string, Column>();
	for (const c of components) {
		for (const o of c.outputs) for (const col of o.columns) outputColumns.set(col.key, col);
	}
	for (const c of components) {
		for (const i of c.inputs) {
			for (const col of i.columns) {
				const upstream = col.lineage ? outputColumns.get(col.lineage) : undefined;
				if (!col.name && upstream) col.name = upstream.name;
				if (!col.dataType && upstream) col.dataType = upstream.dataType;
			}
		}
	}

	const pathsEl = child(data, "paths");
	const paths: Path[] = (pathsEl ? childElements(pathsEl, "path") : []).map((p) => {
		const from = attr(p, "startId") ?? "";
		const to = attr(p, "endId") ?? "";
		return {
			name: attr(p, "name") ?? "",
			from,
			fromComponent: portOwner.get(from)?.component,
			fromOutput: portOwner.get(from)?.port,
			to,
			toComponent: portOwner.get(to)?.component,
			toInput: portOwner.get(to)?.port,
		};
	});

	return { components, paths };
}
