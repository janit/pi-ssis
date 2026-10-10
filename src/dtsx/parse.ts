import type {
	Connection,
	Constraint,
	Executable,
	ExecutePackageTask,
	ForEachLoop,
	Package,
	Parameter,
	ScriptTask,
	SqlTask,
	TaskKind,
	Variable,
} from "./model.ts";
import { parsePipeline } from "./pipeline.ts";
import { attr, child, childElements, descendants, parseXml, text, type XElement } from "./xml.ts";

export class EncryptedPackageError extends Error {}

/** VARENUM codes used by DTS:DataType. */
const DATA_TYPES: Record<string, string> = {
	"0": "Empty",
	"1": "DBNull",
	"2": "Int16",
	"3": "Int32",
	"4": "Single",
	"5": "Double",
	"6": "Currency",
	"7": "DateTime",
	"8": "String",
	"11": "Boolean",
	"13": "Object",
	"14": "Decimal",
	"16": "SByte",
	"17": "Byte",
	"18": "UInt16",
	"19": "UInt32",
	"20": "Int64",
	"21": "UInt64",
	"72": "Guid",
	"129": "String",
	"130": "String",
};

export const DATA_TYPE_CODES: Record<string, string> = {
	Int16: "2",
	Int32: "3",
	Single: "4",
	Double: "5",
	DateTime: "7",
	String: "8",
	Boolean: "11",
	Object: "13",
	Decimal: "14",
	SByte: "16",
	Byte: "17",
	UInt16: "18",
	UInt32: "19",
	Int64: "20",
	UInt64: "21",
};

export function dataTypeName(code: string | undefined): string {
	if (!code) return "String";
	return DATA_TYPES[code] ?? code;
}

const PROTECTION_LEVELS = [
	"DontSaveSensitive",
	"EncryptSensitiveWithUserKey",
	"EncryptSensitiveWithPassword",
	"EncryptAllWithPassword",
	"EncryptAllWithUserKey",
	"ServerStorage",
];

/**
 * Reads a DTS property. Format 6+ stores properties as attributes, format 2-5
 * as `<DTS:Property DTS:Name="...">` children; both are accepted everywhere.
 */
export function prop(el: XElement, name: string): string | undefined {
	const direct = attr(el, name);
	if (direct !== undefined) return direct;
	for (const c of el.children) {
		if (c.type === "element" && c.local === "Property" && attr(c, "Name") === name) {
			return isEncrypted(c) ? "<encrypted>" : text(c);
		}
	}
	return undefined;
}

function isEncrypted(el: XElement): boolean {
	return attr(el, "Encrypted") === "1" || child(el, "EncryptedData") !== undefined;
}

export function truthy(value: string | undefined): boolean {
	return value === "True" || value === "true" || value === "-1" || value === "1";
}

export function taskKind(type: string): TaskKind {
	const t = type.toLowerCase();
	if (t.includes("package") && !t.includes("executepackage")) return "Package";
	if (t.includes("stock:sequence") || t === "microsoft.sequence") return "Sequence";
	if (t.includes("foreachloop")) return "ForEachLoop";
	if (t.includes("forloop")) return "ForLoop";
	if (t.includes("executesql")) return "ExecuteSQL";
	if (t.includes("pipeline")) return "DataFlow";
	if (t.includes("executepackage")) return "ExecutePackage";
	if (t.includes("scripttask")) return "Script";
	if (t.includes("expressiontask")) return "Expression";
	if (t.includes("filesystemtask")) return "FileSystem";
	if (t.includes("executeprocess")) return "ExecuteProcess";
	if (t.includes("sendmail")) return "SendMail";
	if (t.includes("ftptask")) return "FTP";
	if (t.includes("bulkinsert")) return "BulkInsert";
	if (t.includes("xmltask")) return "XML";
	if (t.includes("webservice")) return "WebService";
	return "Other";
}

/** Short readable name for an arbitrary task or enumerator type string. */
export function shortTypeName(type: string): string {
	const first = type.split(",")[0]!.trim();
	const last = first.split(".").pop()!;
	return last.replace(/^STOCK:/, "") || type;
}

function expressions(el: XElement): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pe of childElements(el, "PropertyExpression")) {
		const name = attr(pe, "Name");
		if (name) out[name] = text(pe);
	}
	return out;
}

/** Decodes `_x000D__x000A_` style escapes used for delimiters. */
function decodeXmlName(value: string): string {
	return value
		.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t");
}

export function parseConnection(el: XElement, scope: "package" | "project"): Connection {
	const inner = child(el, "ObjectData") ? childElements(child(el, "ObjectData")!)[0] : undefined;
	const properties: Record<string, string> = {};
	let connectionString: string | undefined;
	let flatFileColumns: Connection["flatFileColumns"];
	if (inner) {
		connectionString = prop(inner, "ConnectionString");
		for (const a of inner.attrs) {
			if (a.local === "ConnectionString" || a.name.startsWith("xmlns")) continue;
			properties[a.local] = decodeXmlName(a.value);
		}
		for (const p of childElements(inner, "Property")) {
			const name = attr(p, "Name");
			if (name && name !== "ConnectionString" && text(p)) properties[name] = decodeXmlName(text(p));
		}
		const columns: XElement[] = [];
		descendants(inner, (d) => {
			if (d.local === "FlatFileColumn") columns.push(d);
		});
		if (columns.length) {
			flatFileColumns = columns.map((c) => ({
				name: prop(c, "ObjectName") ?? "",
				dataType: dataTypeName(prop(c, "DataType")),
				width: prop(c, "MaximumWidth") ?? prop(c, "ColumnWidth"),
				delimiter: prop(c, "ColumnDelimiter") ? decodeXmlName(prop(c, "ColumnDelimiter")!) : undefined,
			}));
		}
	}
	return {
		name: prop(el, "ObjectName") ?? "",
		id: prop(el, "DTSID") ?? "",
		refId: attr(el, "refId"),
		type: prop(el, "CreationName") ?? "",
		connectionString,
		expressions: expressions(el),
		properties,
		scope,
		flatFileColumns,
	};
}

function parseVariable(el: XElement, scope: string): Variable {
	const valueEl = child(el, "VariableValue");
	const dataType = dataTypeName(valueEl ? attr(valueEl, "DataType") : undefined);
	const expression = prop(el, "Expression");
	return {
		namespace: prop(el, "Namespace") ?? "User",
		name: prop(el, "ObjectName") ?? "",
		dataType,
		value: valueEl && dataType !== "Object" ? text(valueEl) : undefined,
		expression: truthy(prop(el, "EvaluateAsExpression")) && expression ? expression : undefined,
		readOnly: truthy(prop(el, "ReadOnly")),
		scope,
	};
}

function parseParameter(el: XElement): Parameter {
	const valueEl = childElements(el, "Property").find((p) => attr(p, "Name") === "ParameterValue");
	const sensitive = truthy(prop(el, "Sensitive"));
	return {
		name: prop(el, "ObjectName") ?? "",
		dataType: dataTypeName(prop(el, "DataType")),
		value: valueEl ? (isEncrypted(valueEl) || sensitive ? "<sensitive>" : text(valueEl)) : undefined,
		required: truthy(prop(el, "Required")),
		sensitive,
		description: prop(el, "Description") || undefined,
		scope: "package",
	};
}

interface Context {
	connections: Connection[];
	/** DTSID -> refId, for format 3 constraints that reference executables by id. */
	refById: Map<string, string>;
	warnings: string[];
}

export function resolveConnection(ref: string | undefined, connections: Connection[]): string | undefined {
	if (!ref) return undefined;
	const bare = ref.replace(/:external$/i, "");
	const lower = bare.toLowerCase();
	for (const c of connections) {
		if (c.id.toLowerCase() === lower || c.refId?.toLowerCase() === lower || c.name.toLowerCase() === lower) return c.name;
	}
	const named = /ConnectionManagers\[(.+)\]$/.exec(bare);
	return named ? named[1] : undefined;
}

function parseSqlTask(data: XElement, ctx: Context): SqlTask {
	const connectionRef = attr(data, "Connection");
	return {
		connection: resolveConnection(connectionRef, ctx.connections),
		connectionRef,
		statement: attr(data, "SqlStatementSource") ?? "",
		sourceType: attr(data, "SqlStmtSourceType") ?? "DirectInput",
		isStoredProc: truthy(attr(data, "IsStoredProc")),
		resultType: (attr(data, "ResultType") ?? "ResultSetType_None").replace("ResultSetType_", ""),
		parameterBindings: childElements(data, "ParameterBinding").map((b) => ({
			name: attr(b, "ParameterName") ?? "",
			variable: attr(b, "DtsVariableName") ?? "",
			direction: attr(b, "ParameterDirection") ?? "Input",
			dataType: attr(b, "DataType"),
		})),
		resultBindings: childElements(data, "ResultBinding").map((b) => ({
			name: attr(b, "ResultName") ?? "",
			variable: attr(b, "DtsVariableName") ?? "",
		})),
	};
}

function parseExecutePackage(data: XElement, ctx: Context): ExecutePackageTask {
	const value = (name: string) => {
		const el = child(data, name);
		return el ? text(el) : attr(data, name);
	};
	return {
		packageName: value("PackageName"),
		useProjectReference: truthy(value("UseProjectReference")),
		connection: resolveConnection(value("Connection"), ctx.connections),
		parameterAssignments: childElements(data, "ParameterAssignment").map((a) => ({
			parameter: child(a, "ParameterName") ? text(child(a, "ParameterName")!) : "",
			source: child(a, "BindedVariableOrParameterName") ? text(child(a, "BindedVariableOrParameterName")!) : "",
		})),
	};
}

const GENERATED_SCRIPT_FILE = /(assemblyinfo|\.designer|resources|settings)\.(cs|vb)$/i;

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseScriptTask(data: XElement): ScriptTask {
	const files: ScriptTask["files"] = [];
	for (const item of childElements(data, "ProjectItem")) {
		const name = attr(item, "Name") ?? "";
		if (!/\.(cs|vb)$/i.test(name) || GENERATED_SCRIPT_FILE.test(name)) continue;
		files.push({ name, code: text(item).trim() });
	}
	return {
		language: attr(data, "Language"),
		entryPoint: attr(data, "EntryPoint"),
		readOnlyVariables: splitList(attr(data, "ReadOnlyVariables")),
		readWriteVariables: splitList(attr(data, "ReadWriteVariables")),
		files,
	};
}

function parseForEach(el: XElement): ForEachLoop | undefined {
	const enumerator = child(el, "ForEachEnumerator");
	if (!enumerator) return undefined;
	const properties: Record<string, string> = { ...expressionsAsProperties(enumerator) };
	const data = child(enumerator, "ObjectData");
	if (data) {
		descendants(data, (d) => {
			for (const a of d.attrs) {
				if (!a.name.startsWith("xmlns") && a.value !== "") properties[a.local] = a.value;
			}
		});
	}
	const mappings = child(el, "ForEachVariableMappings");
	return {
		enumerator: shortTypeName(prop(enumerator, "CreationName") ?? ""),
		properties,
		variableMappings: (mappings ? childElements(mappings, "ForEachVariableMapping") : []).map((m) => ({
			variable: prop(m, "VariableName") ?? "",
			index: Number(prop(m, "ValueIndex") ?? 0),
		})),
	};
}

function expressionsAsProperties(el: XElement): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(expressions(el))) out[`${k} (expression)`] = v;
	return out;
}

/** Settings worth reporting only when they differ from the designer default. */
const NOTABLE: Record<string, string[]> = {
	TransactionOption: ["1"],
	MaxErrorCount: ["1"],
	FailPackageOnFailure: ["False", "0"],
	FailParentOnFailure: ["False", "0"],
	DelayValidation: ["False", "0"],
	ForceExecutionResult: ["-1"],
	ISOLevel: ["1048576"],
	MaxConcurrentExecutables: ["-1"],
	CheckpointUsage: ["0"],
	SaveCheckpoints: ["False", "0"],
};

const TRANSACTION_OPTIONS = ["NotSupported", "Supported", "Required"];

function notableProperties(el: XElement): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, defaults] of Object.entries(NOTABLE)) {
		const value = prop(el, name);
		if (value === undefined || value === "" || defaults.includes(value)) continue;
		out[name] = name === "TransactionOption" ? (TRANSACTION_OPTIONS[Number(value)] ?? value) : value;
	}
	return out;
}

function genericTaskProperties(data: XElement): Record<string, string> {
	const out: Record<string, string> = {};
	const collect = (el: XElement, depth: number) => {
		for (const a of el.attrs) {
			if (!a.name.startsWith("xmlns") && a.value !== "") out[a.local] = a.value;
		}
		for (const c of childElements(el)) {
			const hasElements = c.children.some((n) => n.type === "element");
			if (!hasElements && text(c).trim() && c.local !== "BinaryItem") out[c.local] = text(c).trim();
			if (depth < 3) collect(c, depth + 1);
		}
	};
	collect(data, 0);
	return out;
}

const VALUES: Constraint["value"][] = ["Success", "Failure", "Completion"];
const EVAL_OPS: Constraint["evalOp"][] = [
	"Constraint",
	"Expression",
	"Constraint",
	"ExpressionAndConstraint",
	"ExpressionOrConstraint",
];

function parseConstraint(el: XElement, ctx: Context): Constraint {
	let from = prop(el, "From") ?? "";
	let to = prop(el, "To") ?? "";
	for (const ref of childElements(el, "Executable")) {
		const id = attr(ref, "IDREF") ?? "";
		const target = ctx.refById.get(id.toLowerCase()) ?? id;
		if (truthy(attr(ref, "IsFrom"))) from = target;
		else to = target;
	}
	const evalOp = EVAL_OPS[Number(prop(el, "EvalOp") ?? 2)] ?? "Constraint";
	const expression = prop(el, "Expression");
	return {
		name: prop(el, "ObjectName") ?? "Constraint",
		from,
		to,
		value: VALUES[Number(prop(el, "Value") ?? 0)] ?? "Success",
		evalOp,
		expression: evalOp !== "Constraint" && expression ? expression : undefined,
		// The designer writes LogicalAnd="True" explicitly; an absent attribute means OR.
		logicalAnd: truthy(prop(el, "LogicalAnd")),
	};
}

function parseExecutable(el: XElement, parentRef: string | undefined, ctx: Context, forcedKind?: TaskKind): Executable {
	const type = prop(el, "ExecutableType") ?? prop(el, "CreationName") ?? "";
	const kind = forcedKind ?? (parentRef === undefined ? "Package" : taskKind(type));
	const name = (forcedKind === "EventHandler" ? prop(el, "EventName") : undefined) ?? prop(el, "ObjectName") ?? "";
	const refId =
		attr(el, "refId") ??
		(parentRef === undefined ? "Package" : `${parentRef}${forcedKind === "EventHandler" ? ".EventHandlers[" + name + "]" : "\\" + name}`);
	const id = prop(el, "DTSID") ?? "";
	if (id) ctx.refById.set(id.toLowerCase(), refId);

	const exec: Executable = {
		refId,
		name,
		id,
		kind,
		type,
		description: prop(el, "Description") || undefined,
		disabled: truthy(prop(el, "Disabled")),
		properties: notableProperties(el),
		expressions: expressions(el),
		variables: [],
		children: [],
		constraints: [],
		eventHandlers: [],
	};

	const variables = child(el, "Variables");
	const variableEls = variables ? childElements(variables, "Variable") : childElements(el, "Variable");
	exec.variables = variableEls.map((v) => parseVariable(v, refId));

	// Children first, so format 3 constraints can resolve executables by DTSID.
	const executables = child(el, "Executables");
	const childEls = executables ? childElements(executables, "Executable") : directExecutables(el);
	exec.children = childEls.map((c) => parseExecutable(c, refId, ctx));

	const constraints = child(el, "PrecedenceConstraints");
	const constraintEls = constraints
		? childElements(constraints, "PrecedenceConstraint")
		: childElements(el, "PrecedenceConstraint");
	exec.constraints = constraintEls.map((c) => parseConstraint(c, ctx));

	const handlers = child(el, "EventHandlers");
	const handlerEls = handlers ? childElements(handlers, "EventHandler") : childElements(el, "EventHandler");
	exec.eventHandlers = handlerEls.map((h) => parseExecutable(h, refId, ctx, "EventHandler"));

	if (kind === "ForLoop") {
		exec.forLoop = {
			init: prop(el, "InitExpression") || undefined,
			eval: prop(el, "EvalExpression") || undefined,
			assign: prop(el, "AssignExpression") || undefined,
		};
	}
	if (kind === "ForEachLoop") exec.forEach = parseForEach(el);

	const objectData = child(el, "ObjectData");
	const data = objectData ? childElements(objectData)[0] : undefined;
	if (data) {
		try {
			if (kind === "ExecuteSQL") exec.sql = parseSqlTask(data, ctx);
			else if (kind === "ExecutePackage") exec.executePackage = parseExecutePackage(data, ctx);
			else if (kind === "Script") exec.script = parseScriptTask(data);
			else if (kind === "Expression") exec.expression = attr(data, "Expression") ?? "";
			else if (kind === "DataFlow") exec.dataFlow = parsePipeline(data, ctx.connections);
			else if (data.local === "EncryptedData") ctx.warnings.push(`${refId}: task settings are encrypted`);
			else exec.taskProperties = genericTaskProperties(data);
		} catch (error) {
			ctx.warnings.push(`${refId}: could not read task settings (${(error as Error).message})`);
		}
	}
	return exec;
}

/** Format 3 nests child executables directly under their container. */
function directExecutables(el: XElement): XElement[] {
	return childElements(el, "Executable").filter((c) => attr(c, "IDREF") === undefined);
}

export interface ParseOptions {
	/** Project-level connection managers (from .conmgr files) the package may reference. */
	projectConnections?: Connection[];
	/** Fallback package name, normally the file name. */
	fileName?: string;
}

export function parsePackage(source: string, options: ParseOptions = {}): Package {
	const { root } = parseXml(source);
	if (root.local === "EncryptedData") {
		throw new EncryptedPackageError(
			"This package is saved with ProtectionLevel EncryptAllWithPassword/EncryptAllWithUserKey and cannot be read without decrypting it in Visual Studio or with dtutil.",
		);
	}
	if (root.local !== "Executable") {
		throw new Error(`Not an SSIS package: root element is <${root.name}>, expected <DTS:Executable>.`);
	}

	const warnings: string[] = [];
	const managers = child(root, "ConnectionManagers");
	const connectionEls = managers ? childElements(managers, "ConnectionManager") : childElements(root, "ConnectionManager");
	const connections = [
		...connectionEls.map((c) => parseConnection(c, "package")),
		...(options.projectConnections ?? []),
	];
	const ctx: Context = { connections, refById: new Map(), warnings };

	const rootExec = parseExecutable(root, undefined, ctx);
	if (!rootExec.name && options.fileName) rootExec.name = options.fileName.replace(/\.dtsx$/i, "");

	const params = child(root, "PackageParameters");
	const parameters = params ? childElements(params, "PackageParameter").map(parseParameter) : [];

	const configs = child(root, "Configurations");
	const configEls = configs ? childElements(configs, "Configuration") : childElements(root, "Configuration");
	const CONFIG_TYPES: Record<string, string> = {
		"0": "ParentVariable",
		"1": "ConfigFile",
		"2": "EnvironmentVariable",
		"3": "RegistryEntry",
		"4": "IndirectParentVariable",
		"5": "IndirectConfigFile",
		"6": "IndirectRegistryEntry",
		"7": "SqlServer",
		"8": "IniFile",
		"9": "IndirectSqlServer",
		"10": "IndirectIniFile",
	};

	const providers = child(root, "LogProviders");
	const providerEls = providers ? childElements(providers, "LogProvider") : childElements(root, "LogProvider");

	const level = prop(root, "ProtectionLevel");
	return {
		name: rootExec.name,
		id: rootExec.id,
		formatVersion: Number(prop(root, "PackageFormatVersion") ?? 0),
		protectionLevel: level === undefined ? "EncryptSensitiveWithUserKey" : (PROTECTION_LEVELS[Number(level)] ?? level),
		description: rootExec.description,
		connections,
		parameters,
		configurations: configEls.map((c) => ({
			name: prop(c, "ObjectName") ?? "",
			type: CONFIG_TYPES[prop(c, "ConfigurationType") ?? ""] ?? prop(c, "ConfigurationType") ?? "",
			target: prop(c, "ConfigurationVariable") || undefined,
			source: prop(c, "ConfigurationString") || undefined,
		})),
		logProviders: providerEls.map((p) => prop(p, "ObjectName") ?? shortTypeName(prop(p, "CreationName") ?? "")),
		root: rootExec,
		warnings,
	};
}
