import { randomUUID } from "node:crypto";
import type { Connection } from "../dtsx/model.ts";
import { DATA_TYPE_CODES, prop, resolveConnection, parseConnection, taskKind } from "../dtsx/parse.ts";
import { attr, child, childElements, descendants, escapeAttr, findAttr, parseXml, type XDocument, type XElement } from "../dtsx/xml.ts";
import { applySplices, element, insertChild, removeAttr, removeElement, setAttr, setText, type Splice } from "./splice.ts";
import { type Issue, validatePackage } from "./validate.ts";

export type EditOp =
	| { op: "set_sql"; target: string; sql: string }
	| { op: "set_property"; target: string; property: string; value: string }
	| { op: "set_connection_string"; connection: string; value: string }
	| { op: "set_expression"; target: string; property: string; expression?: string }
	| { op: "set_disabled"; target: string; disabled: boolean }
	| { op: "add_variable"; name: string; namespace?: string; dataType?: string; value?: string; expression?: string; scope?: string }
	| { op: "remove_variable"; name: string; scope?: string; force?: boolean }
	| { op: "rename_variable"; name: string; newName: string }
	| { op: "add_parameter"; name: string; dataType?: string; value?: string; required?: boolean; description?: string }
	| { op: "remove_parameter"; name: string; force?: boolean }
	| { op: "rename_parameter"; name: string; newName: string }
	| { op: "add_execute_sql_task"; name: string; connection: string; sql: string; parent?: string; after?: string }
	| { op: "add_constraint"; from: string; to: string; value?: "success" | "failure" | "completion"; expression?: string; combine?: "and" | "or" | "expression_only"; logicalAnd?: boolean }
	| { op: "remove_constraint"; from: string; to: string };

export class EditError extends Error {}

/** Child element order the designer writes; new sections are inserted to match. */
const ORDER = [
	"Property",
	"ConnectionManagers",
	"Configurations",
	"LogProviders",
	"PackageParameters",
	"ForEachEnumerator",
	"Variables",
	"LoggingOptions",
	"PropertyExpression",
	"Executables",
	"PrecedenceConstraints",
	"ForEachVariableMappings",
	"EventHandlers",
	"ObjectData",
	"DesignTimeProperties",
];

/** DTS attributes that may be created when absent (absent means the default). */
const CREATABLE = new Set([
	"Description",
	"Disabled",
	"DelayValidation",
	"FailPackageOnFailure",
	"FailParentOnFailure",
	"MaxErrorCount",
	"TransactionOption",
	"ISOLevel",
	"ForceExecutionResult",
	"MaxConcurrentExecutables",
]);

const EXECUTE_SQL_LONG =
	"Microsoft.SqlServer.Dts.Tasks.ExecuteSQLTask.ExecuteSQLTask, Microsoft.SqlServer.SQLTask, Version=11.0.0.0, Culture=neutral, PublicKeyToken=89845dcd8080cc91";
const SQL_TASK_NS = 'xmlns:SQLTask="www.microsoft.com/sqlserver/dts/tasks/sqltask"';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function guid(): string {
	return `{${randomUUID().toUpperCase()}}`;
}

interface Index {
	doc: XDocument;
	executables: XElement[];
	components: XElement[];
	connections: XElement[];
}

function buildIndex(source: string): Index {
	const doc = parseXml(source);
	const index: Index = { doc, executables: [], components: [], connections: [] };
	const visit = (el: XElement) => {
		if (el.prefix === "DTS" && (el.local === "Executable" || el.local === "EventHandler")) index.executables.push(el);
		else if (el.local === "component" && el.prefix === "") index.components.push(el);
		else if (el.prefix === "DTS" && el.local === "ConnectionManager" && el.parent?.local !== "ObjectData") index.connections.push(el);
	};
	visit(doc.root);
	descendants(doc.root, visit);
	return index;
}

function executableRef(el: XElement): string {
	return attr(el, "refId") ?? "";
}

function findOne(candidates: XElement[], target: string, ref: (el: XElement) => string, name: (el: XElement) => string, what: string): XElement {
	const lower = target.toLowerCase();
	const byRef = candidates.filter((c) => ref(c).toLowerCase() === lower);
	if (byRef.length === 1) return byRef[0]!;
	const byName = candidates.filter((c) => name(c).toLowerCase() === lower);
	if (byName.length === 1) return byName[0]!;
	if (byName.length > 1) {
		throw new EditError(`"${target}" matches ${byName.length} ${what}s; use the refId instead: ${byName.map(ref).join(", ")}`);
	}
	const available = candidates.map((c) => ref(c) || name(c)).filter(Boolean);
	throw new EditError(`No ${what} "${target}". Available: ${available.slice(0, 40).join(", ") || "none"}`);
}

function findExecutable(index: Index, target: string): XElement {
	return findOne(index.executables, target, executableRef, (e) => attr(e, "ObjectName") ?? "", "task or container");
}

function findConnection(index: Index, target: string): XElement {
	if (index.doc.root.local === "ConnectionManager") return index.doc.root;
	return findOne(index.connections, target, (e) => attr(e, "refId") ?? "", (e) => attr(e, "ObjectName") ?? "", "connection manager");
}

/** Resolves a target that may be a task, a data flow component or a connection manager. */
function findTarget(index: Index, target: string): { el: XElement; type: "executable" | "component" | "connection" } {
	const lower = target.toLowerCase();
	const matches: { el: XElement; type: "executable" | "component" | "connection" }[] = [];
	for (const e of index.executables) {
		if (executableRef(e).toLowerCase() === lower || (attr(e, "ObjectName") ?? "").toLowerCase() === lower) matches.push({ el: e, type: "executable" });
	}
	for (const c of index.components) {
		if ((attr(c, "refId") ?? "").toLowerCase() === lower || (attr(c, "name") ?? "").toLowerCase() === lower) matches.push({ el: c, type: "component" });
	}
	for (const c of index.connections) {
		if ((attr(c, "refId") ?? "").toLowerCase() === lower || (attr(c, "ObjectName") ?? "").toLowerCase() === lower) matches.push({ el: c, type: "connection" });
	}
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) {
		throw new EditError(`"${target}" is ambiguous; use a refId: ${matches.map((m) => attr(m.el, "refId")).join(", ")}`);
	}
	throw new EditError(`Nothing named "${target}". Use ssis_package to list tasks and connections, ssis_dataflow for components.`);
}

function taskData(el: XElement): XElement | undefined {
	const data = child(el, "ObjectData");
	return data ? childElements(data)[0] : undefined;
}

function componentProperty(component: XElement, name: string): XElement | undefined {
	const props = child(component, "properties");
	return props ? childElements(props, "property").find((p) => attr(p, "name") === name) : undefined;
}

/** Inserts a new section into an executable at the position the designer would use. */
function insertOrdered(source: string, parent: XElement, local: string, xml: string): Splice[] {
	const rank = ORDER.indexOf(local);
	const before = childElements(parent).find((c) => ORDER.indexOf(c.local) > rank);
	return insertChild(source, parent, xml, before);
}

/** Adds `xml` to a named container child (e.g. DTS:Variables), creating the container when missing. */
function addToContainer(source: string, owner: XElement, container: string, xml: string): Splice[] {
	const existing = child(owner, container);
	if (existing) return insertChild(source, existing, xml);
	return insertOrdered(source, owner, container, element(`DTS:${container}`, [], [xml]));
}

interface OpContext {
	source: string;
	index: Index;
	projectConnections: Connection[];
	notes: string[];
}

type Handler<K extends EditOp["op"]> = (op: Extract<EditOp, { op: K }>, ctx: OpContext) => Splice[];

function allConnections(ctx: OpContext): Connection[] {
	return [...ctx.index.connections.map((c) => parseConnection(c, "package")), ...ctx.projectConnections];
}

const setSql: Handler<"set_sql"> = (op, ctx) => {
	const target = findTarget(ctx.index, op.target);
	if (target.type === "component") {
		const property = componentProperty(target.el, "SqlCommand");
		if (!property) throw new EditError(`Component "${op.target}" has no SqlCommand property.`);
		ctx.notes.push("Column metadata was not refreshed. If the new query returns different columns, open the data flow in Visual Studio so it can resynchronise them.");
		return setText(ctx.source, property, op.sql);
	}
	if (target.type !== "executable" || taskKind(attr(target.el, "ExecutableType") ?? "") !== "ExecuteSQL") {
		throw new EditError(`"${op.target}" is not an Execute SQL task or a data flow component with a SQL command.`);
	}
	const data = taskData(target.el);
	if (!data) throw new EditError(`"${op.target}" has no task settings to edit.`);
	const sourceType = attr(data, "SqlStmtSourceType");
	if (sourceType && sourceType !== "DirectInput") {
		ctx.notes.push(`This task reads its statement from a ${sourceType}; the value you set is the name of that source, not SQL text.`);
	}
	const resultType = (attr(data, "ResultType") ?? "ResultSetType_None").replace("ResultSetType_", "");
	if (resultType !== "None") {
		ctx.notes.push(`This task stores a ${resultType} result in variables; the new statement must still return that result or the task fails at run time.`);
	}
	return setAttr(ctx.source, data, `${data.prefix ? `${data.prefix}:` : ""}SqlStatementSource`, op.sql);
};

const setProperty: Handler<"set_property"> = (op, ctx) => {
	const target = findTarget(ctx.index, op.target);
	if (target.type === "component") {
		const property = componentProperty(target.el, op.property);
		if (property) return setText(ctx.source, property, op.value);
		if (findAttr(target.el, op.property)) return setAttr(ctx.source, target.el, op.property, op.value);
		const names = childElements(child(target.el, "properties") ?? target.el, "property").map((p) => attr(p, "name"));
		throw new EditError(`Component "${op.target}" has no property "${op.property}". Available: ${names.join(", ")}`);
	}
	if (["DTSID", "refId", "ObjectName", "ExecutableType", "CreationName"].includes(op.property)) {
		throw new EditError(`${op.property} identifies the object and is referenced elsewhere; it cannot be changed with set_property.`);
	}
	const inner = taskData(target.el);
	if (findAttr(target.el, op.property)) return setAttr(ctx.source, target.el, `DTS:${op.property}`, op.value);
	if (inner && findAttr(inner, op.property)) {
		const existing = findAttr(inner, op.property)!;
		return setAttr(ctx.source, inner, existing.name, op.value);
	}
	if (CREATABLE.has(op.property)) return setAttr(ctx.source, target.el, `DTS:${op.property}`, op.value);
	const available = [...target.el.attrs, ...(inner?.attrs ?? [])].filter((a) => !a.name.startsWith("xmlns")).map((a) => a.local);
	throw new EditError(`"${op.target}" has no property "${op.property}". Existing properties: ${available.join(", ")}. Can also be created: ${[...CREATABLE].join(", ")}`);
};

const setConnectionString: Handler<"set_connection_string"> = (op, ctx) => {
	const connection = findConnection(ctx.index, op.connection);
	const inner = taskData(connection);
	if (!inner) throw new EditError(`Connection manager "${op.connection}" has no settings to edit.`);
	if (childElements(connection, "PropertyExpression").some((p) => attr(p, "Name") === "ConnectionString")) {
		ctx.notes.push("This connection has a ConnectionString expression, which overrides the stored value at run time.");
	}
	return setAttr(ctx.source, inner, "DTS:ConnectionString", op.value);
};

const setExpression: Handler<"set_expression"> = (op, ctx) => {
	const target = findTarget(ctx.index, op.target);
	if (target.type === "component") {
		throw new EditError("Data flow component expressions are stored on the data flow task as [Component].[Property]; target the data flow task instead.");
	}
	const existing = childElements(target.el, "PropertyExpression").find((p) => attr(p, "Name") === op.property);
	if (op.expression === undefined || op.expression === "") {
		if (!existing) throw new EditError(`"${op.target}" has no expression on ${op.property}.`);
		return removeElement(ctx.source, existing);
	}
	if (existing) return setText(ctx.source, existing, op.expression);
	const xml = element("DTS:PropertyExpression", [["DTS:Name", op.property]], { text: op.expression });
	return insertOrdered(ctx.source, target.el, "PropertyExpression", xml);
};

const setDisabled: Handler<"set_disabled"> = (op, ctx) => {
	const el = findExecutable(ctx.index, op.target);
	if (el === ctx.index.doc.root) throw new EditError("The package itself cannot be disabled.");
	return op.disabled ? setAttr(ctx.source, el, "DTS:Disabled", "True") : removeAttr(ctx.source, el, "Disabled");
};

function variableValue(dataType: string, value: string | undefined): string {
	if (dataType === "Boolean") return /^(true|-1|1)$/i.test(value ?? "") ? "-1" : "0";
	if (value === undefined || value === "") return ["String", "Object", "DateTime"].includes(dataType) ? "" : "0";
	if (/^(U?Int|S?Byte|Single|Double|Decimal)/.test(dataType) && !/^-?\d+(\.\d+)?$/.test(value)) {
		throw new EditError(`"${value}" is not a valid ${dataType} value.`);
	}
	return value;
}

function typeCode(dataType: string | undefined): { name: string; code: string } {
	const name = dataType ?? "String";
	const code = DATA_TYPE_CODES[name];
	if (!code) throw new EditError(`Unknown data type "${name}". Use one of: ${Object.keys(DATA_TYPE_CODES).join(", ")}`);
	return { name, code };
}

function variablesOf(el: XElement): XElement[] {
	const container = child(el, "Variables");
	return container ? childElements(container, "Variable") : [];
}

function findVariables(index: Index, name: string, scope?: string): { el: XElement; namespace: string; name: string }[] {
	const wanted = name.includes("::") ? name.toLowerCase() : `user::${name}`.toLowerCase();
	const owners = scope ? [findExecutable(index, scope)] : index.executables;
	const out: { el: XElement; namespace: string; name: string }[] = [];
	for (const owner of owners) {
		for (const v of variablesOf(owner)) {
			const ns = attr(v, "Namespace") ?? "User";
			const n = attr(v, "ObjectName") ?? "";
			if (`${ns}::${n}`.toLowerCase() === wanted) out.push({ el: v, namespace: ns, name: n });
		}
	}
	return out;
}

const addVariable: Handler<"add_variable"> = (op, ctx) => {
	if (!NAME.test(op.name)) throw new EditError(`"${op.name}" is not a valid variable name (letters, digits and underscore; must not start with a digit).`);
	const namespace = op.namespace ?? "User";
	const owner = op.scope ? findExecutable(ctx.index, op.scope) : ctx.index.doc.root;
	if (findVariables(ctx.index, `${namespace}::${op.name}`).some((v) => v.el.parent?.parent === owner)) {
		throw new EditError(`Variable ${namespace}::${op.name} already exists in that scope.`);
	}
	const { name: dataType, code } = typeCode(op.dataType);
	const value = variableValue(dataType, op.value);
	const valueXml =
		value === "" && dataType === "String"
			? `<DTS:VariableValue\n  DTS:DataType="${code}"\n  xml:space="preserve"></DTS:VariableValue>`
			: element("DTS:VariableValue", [["DTS:DataType", code]], { text: value });
	const xml = element(
		"DTS:Variable",
		[
			["DTS:CreationName", ""],
			["DTS:DTSID", guid()],
			["DTS:EvaluateAsExpression", op.expression ? "True" : undefined],
			["DTS:Expression", op.expression || undefined],
			["DTS:IncludeInDebugDump", dataType === "String" ? "2345" : "6789"],
			["DTS:Namespace", namespace],
			["DTS:ObjectName", op.name],
		],
		[valueXml],
	);
	return addToContainer(ctx.source, owner, "Variables", xml);
};

/** Places in the raw source where `token` appears as a whole name, outside `skip`. */
function tokenUses(source: string, token: string, skip: XElement[]): number[] {
	const pattern = new RegExp(`(?<![\\w$])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "g");
	const uses: number[] = [];
	for (const match of source.matchAll(pattern)) {
		if (!skip.some((s) => match.index >= s.start && match.index < s.end)) uses.push(match.index);
	}
	return uses;
}

function layoutSection(index: Index): XElement[] {
	const layout = child(index.doc.root, "DesignTimeProperties");
	return layout ? [layout] : [];
}

const removeVariable: Handler<"remove_variable"> = (op, ctx) => {
	const found = findVariables(ctx.index, op.name, op.scope);
	if (!found.length) throw new EditError(`No variable "${op.name}".`);
	if (found.length > 1) throw new EditError(`"${op.name}" is declared in ${found.length} scopes; pass scope to choose one.`);
	const v = found[0]!;
	const uses = tokenUses(ctx.source, `${v.namespace}::${v.name}`, [v.el, ...layoutSection(ctx.index)]);
	if (uses.length && !op.force) {
		throw new EditError(`${v.namespace}::${v.name} is still referenced in ${uses.length} place(s). Use ssis_search to find them, or pass force to remove it anyway.`);
	}
	return removeElement(ctx.source, v.el);
};

function renameToken(source: string, from: string, to: string, skip: XElement[]): Splice[] {
	return tokenUses(source, from, skip).map((start) => ({ start, end: start + from.length, text: to }));
}

const renameVariable: Handler<"rename_variable"> = (op, ctx) => {
	if (!NAME.test(op.newName)) throw new EditError(`"${op.newName}" is not a valid variable name.`);
	const found = findVariables(ctx.index, op.name);
	if (!found.length) throw new EditError(`No variable "${op.name}".`);
	if (found.length > 1) throw new EditError(`"${op.name}" is declared in ${found.length} scopes; renaming it is ambiguous. Rename it in Visual Studio.`);
	const v = found[0]!;
	if (findVariables(ctx.index, `${v.namespace}::${op.newName}`).length) throw new EditError(`${v.namespace}::${op.newName} already exists.`);
	const nameAttr = findAttr(v.el, "ObjectName")!;
	const splices: Splice[] = [{ start: nameAttr.valueStart, end: nameAttr.valueEnd, text: op.newName }];
	const qualified = `${v.namespace}::${v.name}`;

	// Script tasks may list variables without their namespace; rewrite those lists whole.
	let bare = 0;
	const lists: XElement[] = [];
	descendants(ctx.index.doc.root, (el) => {
		for (const a of el.attrs) {
			if (a.local !== "ReadOnlyVariables" && a.local !== "ReadWriteVariables") continue;
			const items = a.value.split(",");
			if (!items.some((i) => i.trim() === v.name)) continue;
			bare++;
			const renamed = items.map((i) => (i.trim() === v.name || i.trim() === qualified ? i.replace(v.name, op.newName) : i));
			splices.push({ start: a.valueStart, end: a.valueEnd, text: escapeAttr(renamed.join(",")) });
			lists.push({ start: a.valueStart, end: a.valueEnd } as XElement);
		}
	});
	splices.push(...renameToken(ctx.source, qualified, `${v.namespace}::${op.newName}`, [...layoutSection(ctx.index), ...lists]));
	ctx.notes.push(`Updated ${splices.length - 1 - bare} qualified reference(s) and ${bare} script variable list(s). Script code that reads the variable by a bare name (e.g. Dts.Variables["${v.name}"]) is not rewritten; check script tasks.`);
	return splices;
};

function parametersOf(index: Index): XElement[] {
	const container = child(index.doc.root, "PackageParameters");
	return container ? childElements(container, "PackageParameter") : [];
}

function findParameter(index: Index, name: string): XElement {
	const bare = name.replace(/^\$Package::/i, "");
	return findOne(parametersOf(index), bare, () => "", (e) => attr(e, "ObjectName") ?? "", "package parameter");
}

const addParameter: Handler<"add_parameter"> = (op, ctx) => {
	if (!NAME.test(op.name)) throw new EditError(`"${op.name}" is not a valid parameter name.`);
	if (parametersOf(ctx.index).some((p) => (attr(p, "ObjectName") ?? "").toLowerCase() === op.name.toLowerCase())) {
		throw new EditError(`Parameter ${op.name} already exists.`);
	}
	const { name: dataType, code } = typeCode(op.dataType);
	if (dataType === "Object") throw new EditError("Parameters cannot be of type Object.");
	const xml = element(
		"DTS:PackageParameter",
		[
			["DTS:CreationName", ""],
			["DTS:DataType", code],
			["DTS:Description", op.description || undefined],
			["DTS:DTSID", guid()],
			["DTS:ObjectName", op.name],
			["DTS:Required", op.required ? "True" : undefined],
		],
		[
			element(
				"DTS:Property",
				[
					["DTS:DataType", code],
					["DTS:Name", "ParameterValue"],
				],
				{ text: variableValue(dataType, op.value) },
			),
		],
	);
	return addToContainer(ctx.source, ctx.index.doc.root, "PackageParameters", xml);
};

const removeParameter: Handler<"remove_parameter"> = (op, ctx) => {
	const el = findParameter(ctx.index, op.name);
	const name = attr(el, "ObjectName")!;
	const uses = tokenUses(ctx.source, `$Package::${name}`, [el, ...layoutSection(ctx.index)]);
	if (uses.length && !op.force) {
		throw new EditError(`$Package::${name} is still referenced in ${uses.length} place(s). Use ssis_search to find them, or pass force to remove it anyway.`);
	}
	ctx.notes.push("Parent packages and SSISDB environment references that set this parameter are not updated.");
	return removeElement(ctx.source, el);
};

const renameParameter: Handler<"rename_parameter"> = (op, ctx) => {
	if (!NAME.test(op.newName)) throw new EditError(`"${op.newName}" is not a valid parameter name.`);
	const el = findParameter(ctx.index, op.name);
	const name = attr(el, "ObjectName")!;
	if (parametersOf(ctx.index).some((p) => attr(p, "ObjectName") === op.newName)) throw new EditError(`Parameter ${op.newName} already exists.`);
	const nameAttr = findAttr(el, "ObjectName")!;
	const splices: Splice[] = [{ start: nameAttr.valueStart, end: nameAttr.valueEnd, text: op.newName }];
	splices.push(...renameToken(ctx.source, `$Package::${name}`, `$Package::${op.newName}`, layoutSection(ctx.index)));
	ctx.notes.push(`Updated ${splices.length - 1} reference(s) in this package. Parent packages that pass this parameter and SSISDB environment references must be updated separately.`);
	return splices;
};

function isContainer(el: XElement): boolean {
	const kind = taskKind(attr(el, "ExecutableType") ?? attr(el, "CreationName") ?? "");
	return el.local === "EventHandler" || el.parent === undefined || ["Sequence", "ForLoop", "ForEachLoop"].includes(kind);
}

function childExecutables(container: XElement): XElement[] {
	const wrapper = child(container, "Executables");
	return wrapper ? childElements(wrapper, "Executable") : [];
}

function containerOf(el: XElement): XElement {
	const owner = el.parent?.parent;
	if (!owner) throw new EditError("The package itself cannot be used in a precedence constraint.");
	return owner;
}

const VALUE_CODES = { success: undefined, failure: "1", completion: "2" } as const;
const COMBINE_CODES = { expression_only: "1", and: "3", or: "4" } as const;

function constraintXml(container: XElement, from: string, to: string, op: { value?: keyof typeof VALUE_CODES; expression?: string; combine?: keyof typeof COMBINE_CODES; logicalAnd?: boolean }): string {
	const existing = child(container, "PrecedenceConstraints");
	const names = new Set((existing ? childElements(existing, "PrecedenceConstraint") : []).map((c) => attr(c, "ObjectName")));
	let name = "Constraint";
	for (let i = 1; names.has(name); i++) name = `Constraint ${i}`;
	return element("DTS:PrecedenceConstraint", [
		["DTS:refId", `${executableRef(container)}.PrecedenceConstraints[${name}]`],
		["DTS:CreationName", ""],
		["DTS:DTSID", guid()],
		["DTS:EvalOp", op.expression ? COMBINE_CODES[op.combine ?? "and"] : undefined],
		["DTS:Expression", op.expression || undefined],
		["DTS:From", from],
		["DTS:LogicalAnd", op.logicalAnd === false ? undefined : "True"],
		["DTS:ObjectName", name],
		["DTS:To", to],
		["DTS:Value", VALUE_CODES[op.value ?? "success"]],
	]);
}

const addConstraint: Handler<"add_constraint"> = (op, ctx) => {
	const from = findExecutable(ctx.index, op.from);
	const to = findExecutable(ctx.index, op.to);
	const container = containerOf(from);
	if (containerOf(to) !== container) {
		throw new EditError("Both tasks must be in the same container; precedence constraints cannot cross container boundaries.");
	}
	if (op.combine === "expression_only" && !op.expression) throw new EditError("combine expression_only needs an expression.");
	const existing = child(container, "PrecedenceConstraints");
	for (const c of existing ? childElements(existing, "PrecedenceConstraint") : []) {
		if (attr(c, "From") === executableRef(from) && attr(c, "To") === executableRef(to)) {
			throw new EditError(`A constraint from "${op.from}" to "${op.to}" already exists; remove it first to change it.`);
		}
	}
	return addToContainer(ctx.source, container, "PrecedenceConstraints", constraintXml(container, executableRef(from), executableRef(to), op));
};

const removeConstraint: Handler<"remove_constraint"> = (op, ctx) => {
	const from = executableRef(findExecutable(ctx.index, op.from));
	const to = executableRef(findExecutable(ctx.index, op.to));
	const matches: XElement[] = [];
	descendants(ctx.index.doc.root, (el) => {
		if (el.local === "PrecedenceConstraint" && attr(el, "From") === from && attr(el, "To") === to) matches.push(el);
	});
	if (!matches.length) throw new EditError(`No precedence constraint from "${op.from}" to "${op.to}".`);
	const wrapper = matches[0]!.parent!;
	// Leave an empty section self-closed rather than with a dangling body.
	if (childElements(wrapper).length === matches.length) return removeElement(ctx.source, wrapper);
	return matches.flatMap((m) => removeElement(ctx.source, m));
};

const addExecuteSqlTask: Handler<"add_execute_sql_task"> = (op, ctx) => {
	if (/[\\/:[\].=]/.test(op.name) || !op.name.trim()) throw new EditError(`Task name "${op.name}" is empty or contains one of \\ / : [ ] . =`);
	const after = op.after ? findExecutable(ctx.index, op.after) : undefined;
	const parent = op.parent ? findExecutable(ctx.index, op.parent) : after ? containerOf(after) : ctx.index.doc.root;
	if (!isContainer(parent)) throw new EditError(`"${op.parent}" is a task, not a container.`);
	if (after && containerOf(after) !== parent) throw new EditError(`"${op.after}" is not in the container the task is being added to.`);
	if (childExecutables(parent).some((e) => (attr(e, "ObjectName") ?? "").toLowerCase() === op.name.toLowerCase())) {
		throw new EditError(`A task named "${op.name}" already exists in that container.`);
	}

	const connections = allConnections(ctx);
	const connectionName = resolveConnection(op.connection, connections);
	const connection = connections.find((c) => c.name === connectionName);
	if (!connection?.id) {
		throw new EditError(`No connection manager "${op.connection}". Available: ${connections.map((c) => c.name).join(", ") || "none"}`);
	}

	// Copy type strings from an existing Execute SQL task so the new one matches the package's SSIS version.
	const sample = ctx.index.executables.find((e) => taskKind(attr(e, "ExecutableType") ?? "") === "ExecuteSQL");
	const version = Number(prop(ctx.index.doc.root, "PackageFormatVersion") ?? 8);
	const type = sample ? attr(sample, "ExecutableType")! : version >= 8 ? "Microsoft.ExecuteSQLTask" : EXECUTE_SQL_LONG;
	const refId = `${executableRef(parent)}\\${op.name}`;

	const task = element(
		"DTS:Executable",
		[
			["DTS:refId", refId],
			["DTS:CreationName", sample ? (attr(sample, "CreationName") ?? type) : type],
			["DTS:Description", "Execute SQL Task"],
			["DTS:DTSID", guid()],
			["DTS:ExecutableType", type],
			["DTS:LocaleID", "-1"],
			["DTS:ObjectName", op.name],
			["DTS:TaskContact", sample ? attr(sample, "TaskContact") : "Execute SQL Task; Microsoft Corporation; SQL Server 2019; © 2019 Microsoft Corporation; All Rights Reserved;http://www.microsoft.com/sql/support/default.asp;1"],
			["DTS:ThreadHint", "0"],
		],
		[
			"<DTS:Variables />",
			element("DTS:ObjectData", [], [
				element(
					"SQLTask:SqlTaskData",
					[
						["SQLTask:Connection", connection.id],
						["SQLTask:SqlStatementSource", op.sql],
					],
					undefined,
					SQL_TASK_NS,
				),
			]),
		],
	);

	const splices = addToContainer(ctx.source, parent, "Executables", task);
	if (after) {
		splices.push(...addToContainer(ctx.source, parent, "PrecedenceConstraints", constraintXml(parent, executableRef(after), refId, {})));
	}
	ctx.notes.push("The task has no saved position in the designer layout; Visual Studio places it automatically when the package is next opened.");
	return splices;
};

const HANDLERS: { [K in EditOp["op"]]: Handler<K> } = {
	set_sql: setSql,
	set_property: setProperty,
	set_connection_string: setConnectionString,
	set_expression: setExpression,
	set_disabled: setDisabled,
	add_variable: addVariable,
	remove_variable: removeVariable,
	rename_variable: renameVariable,
	add_parameter: addParameter,
	remove_parameter: removeParameter,
	rename_parameter: renameParameter,
	add_execute_sql_task: addExecuteSqlTask,
	add_constraint: addConstraint,
	remove_constraint: removeConstraint,
};

export const EDIT_OPS = Object.keys(HANDLERS) as EditOp["op"][];

/** Fields each operation needs, for callers that receive loosely typed input. */
const REQUIRED: Record<EditOp["op"], string[]> = {
	set_sql: ["target", "sql"],
	set_property: ["target", "property", "value"],
	set_connection_string: ["connection", "value"],
	set_expression: ["target", "property"],
	set_disabled: ["target", "disabled"],
	add_variable: ["name"],
	remove_variable: ["name"],
	rename_variable: ["name", "newName"],
	add_parameter: ["name"],
	remove_parameter: ["name"],
	rename_parameter: ["name", "newName"],
	add_execute_sql_task: ["name", "connection", "sql"],
	add_constraint: ["from", "to"],
	remove_constraint: ["from", "to"],
};

/** Checks untyped operations (e.g. from a model's tool call) and narrows them to EditOp. */
export function checkOps(ops: unknown[]): EditOp[] {
	if (!ops.length) throw new EditError("No operations given.");
	return ops.map((raw, i) => {
		const op = raw as Record<string, unknown>;
		const label = ops.length > 1 ? `Operation ${i + 1}` : "Operation";
		const name = String(op?.op ?? "");
		if (!(name in REQUIRED)) throw new EditError(`${label}: unknown op "${name}". Supported: ${EDIT_OPS.join(", ")}`);
		const missing = REQUIRED[name as EditOp["op"]].filter((f) => op[f] === undefined || op[f] === null);
		if (missing.length) throw new EditError(`${label} (${name}) is missing: ${missing.join(", ")}`);
		return op as unknown as EditOp;
	});
}

export interface EditResult {
	source: string;
	notes: string[];
	/** Issues present after the edit (pre-existing ones included). */
	issues: Issue[];
}

export interface EditOptions {
	projectConnections?: Connection[];
}

/**
 * Applies operations in order and validates the result. Throws without
 * returning anything to write if an operation fails or introduces a
 * structural error.
 */
export function applyEdits(source: string, ops: EditOp[], options: EditOptions = {}): EditResult {
	const root = parseXml(source).root;
	const isConnectionFile = root.local === "ConnectionManager";
	if (!isConnectionFile) {
		const version = Number(prop(root, "PackageFormatVersion") ?? 0);
		if (root.local !== "Executable") throw new EditError(`Not an SSIS package: root element is <${root.name}>.`);
		if (version < 6) {
			throw new EditError(`Package format ${version} (SSIS 2005/2008) is read-only here. Upgrade the package in Visual Studio, then edit it.`);
		}
	}
	const validateOptions = { projectConnections: options.projectConnections };
	const before = isConnectionFile ? [] : validatePackage(source, validateOptions).issues;
	const notes: string[] = [];
	let current = source;

	ops.forEach((op, i) => {
		const handler = HANDLERS[op.op] as Handler<EditOp["op"]> | undefined;
		if (!handler) throw new EditError(`Unknown operation "${(op as { op: string }).op}". Supported: ${EDIT_OPS.join(", ")}`);
		if (isConnectionFile && op.op !== "set_connection_string") throw new EditError(`Only set_connection_string applies to a .conmgr file.`);
		try {
			const ctx: OpContext = { source: current, index: buildIndex(current), projectConnections: options.projectConnections ?? [], notes };
			current = applySplices(current, handler(op, ctx));
			parseXml(current);
		} catch (error) {
			if (ops.length > 1) (error as Error).message = `Operation ${i + 1} (${op.op}): ${(error as Error).message}`;
			throw error;
		}
	});

	const after = isConnectionFile ? [] : validatePackage(current, validateOptions).issues;
	const known = new Set(before.map((i) => `${i.severity}|${i.where}|${i.message}`));
	const introduced = after.filter((i) => i.severity === "error" && !known.has(`${i.severity}|${i.where}|${i.message}`));
	if (introduced.length) {
		throw new EditError(`Edit rejected, it would break the package:\n${introduced.map((i) => `- ${i.where}: ${i.message}`).join("\n")}`);
	}
	return { source: current, notes, issues: after };
}
