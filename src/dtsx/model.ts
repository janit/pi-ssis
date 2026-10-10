/** Typed model of an SSIS package, independent of the XML it was read from. */

export type TaskKind =
	| "Package"
	| "Sequence"
	| "ForLoop"
	| "ForEachLoop"
	| "EventHandler"
	| "ExecuteSQL"
	| "DataFlow"
	| "ExecutePackage"
	| "Script"
	| "Expression"
	| "FileSystem"
	| "ExecuteProcess"
	| "SendMail"
	| "FTP"
	| "BulkInsert"
	| "XML"
	| "WebService"
	| "Other";

export interface Connection {
	name: string;
	id: string;
	refId?: string;
	/** CreationName, e.g. OLEDB, FLATFILE, ADO.NET, EXCEL, FILE, SMTP. */
	type: string;
	connectionString?: string;
	expressions: Record<string, string>;
	properties: Record<string, string>;
	scope: "package" | "project";
	/** Column layout for flat file connections. */
	flatFileColumns?: { name: string; dataType: string; width?: string; delimiter?: string }[];
}

export interface Parameter {
	name: string;
	dataType: string;
	value?: string;
	required: boolean;
	sensitive: boolean;
	description?: string;
	scope: "package" | "project";
}

export interface Variable {
	namespace: string;
	name: string;
	dataType: string;
	value?: string;
	expression?: string;
	readOnly: boolean;
	/** refId of the executable that declares the variable. */
	scope: string;
}

export interface Constraint {
	name: string;
	from: string;
	to: string;
	value: "Success" | "Failure" | "Completion";
	evalOp: "Constraint" | "Expression" | "ExpressionAndConstraint" | "ExpressionOrConstraint";
	expression?: string;
	logicalAnd: boolean;
}

export interface SqlTask {
	connection?: string;
	connectionRef?: string;
	statement: string;
	sourceType: string;
	isStoredProc: boolean;
	resultType: string;
	parameterBindings: { name: string; variable: string; direction: string; dataType?: string }[];
	resultBindings: { name: string; variable: string }[];
}

export interface ExecutePackageTask {
	packageName?: string;
	useProjectReference: boolean;
	connection?: string;
	parameterAssignments: { parameter: string; source: string }[];
}

export interface ScriptTask {
	language?: string;
	entryPoint?: string;
	readOnlyVariables: string[];
	readWriteVariables: string[];
	files: { name: string; code: string }[];
}

export interface ForLoop {
	init?: string;
	eval?: string;
	assign?: string;
}

export interface ForEachLoop {
	enumerator: string;
	properties: Record<string, string>;
	variableMappings: { variable: string; index: number }[];
}

export interface Executable {
	refId: string;
	name: string;
	id: string;
	kind: TaskKind;
	/** Raw ExecutableType / CreationName. */
	type: string;
	description?: string;
	disabled: boolean;
	/** Non-default behavioural settings (TransactionOption, MaxErrorCount, ...). */
	properties: Record<string, string>;
	expressions: Record<string, string>;
	variables: Variable[];
	children: Executable[];
	constraints: Constraint[];
	eventHandlers: Executable[];
	sql?: SqlTask;
	executePackage?: ExecutePackageTask;
	script?: ScriptTask;
	expression?: string;
	forLoop?: ForLoop;
	forEach?: ForEachLoop;
	dataFlow?: Pipeline;
	/** Task-specific settings for tasks without a dedicated shape. */
	taskProperties?: Record<string, string>;
}

export interface Column {
	key: string;
	name: string;
	dataType?: string;
	properties: Record<string, string>;
	/** Destination/source column this column is mapped to. */
	externalColumn?: string;
	/** For input columns: key of the upstream output column. */
	lineage?: string;
	/** For input columns: readOnly / readWrite / ignored. */
	usage?: string;
}

export interface Port {
	key: string;
	name: string;
	isError: boolean;
	properties: Record<string, string>;
	columns: Column[];
	externalColumns: Column[];
}

export interface Component {
	key: string;
	name: string;
	classId: string;
	/** Friendly component type, e.g. OLEDBSource, DerivedColumn, Lookup. */
	kind: string;
	description?: string;
	properties: Record<string, string>;
	script?: ScriptTask;
	connections: { name: string; ref: string; manager?: string }[];
	inputs: Port[];
	outputs: Port[];
}

export interface Path {
	name: string;
	/** Output key the path starts from, and its owning component. */
	from: string;
	fromComponent?: string;
	fromOutput?: string;
	to: string;
	toComponent?: string;
	toInput?: string;
}

export interface Pipeline {
	components: Component[];
	paths: Path[];
}

export interface Package {
	name: string;
	id: string;
	formatVersion: number;
	protectionLevel: string;
	description?: string;
	connections: Connection[];
	parameters: Parameter[];
	/** Legacy (pre-2012) package configurations. */
	configurations: { name: string; type: string; target?: string; source?: string }[];
	logProviders: string[];
	root: Executable;
	/** Things the reader could not interpret; surfaced rather than hidden. */
	warnings: string[];
}

/** Depth-first walk over an executable and everything nested in it. */
export function walk(exec: Executable, visit: (exec: Executable, parent?: Executable) => void, parent?: Executable): void {
	visit(exec, parent);
	for (const c of exec.children) walk(c, visit, exec);
	for (const h of exec.eventHandlers) walk(h, visit, exec);
}

export function findExecutable(pkg: Package, ref: string): Executable | undefined {
	let byRef: Executable | undefined;
	const byName: Executable[] = [];
	const lower = ref.toLowerCase();
	walk(pkg.root, (e) => {
		if (e.refId.toLowerCase() === lower) byRef = e;
		else if (e.name.toLowerCase() === lower) byName.push(e);
	});
	if (byRef) return byRef;
	return byName.length === 1 ? byName[0] : undefined;
}

export function allVariables(pkg: Package): Variable[] {
	const out: Variable[] = [];
	walk(pkg.root, (e) => out.push(...e.variables));
	return out;
}
