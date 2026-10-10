import { readFileSync } from "node:fs";
import { loadProject } from "../dtsx/project.ts";
import type { Row, SqlExecutor, SqlValue } from "./executor.ts";

export class CatalogError extends Error {}

export const STATUS: Record<number, string> = {
	1: "created",
	2: "running",
	3: "canceled",
	4: "failed",
	5: "pending",
	6: "ended unexpectedly",
	7: "succeeded",
	8: "stopping",
	9: "completed",
};

const ACTIVE = new Set([1, 2, 5, 8]);
const MESSAGE_TYPES: Record<number, string> = { 110: "warning", 120: "error", 130: "task failed", 70: "information", 140: "progress" };

function statusCode(name: string): number {
	const entry = Object.entries(STATUS).find(([, v]) => v === name.toLowerCase());
	if (!entry) throw new CatalogError(`Unknown status "${name}". Use one of: ${Object.values(STATUS).join(", ")}`);
	return Number(entry[0]);
}

/** Adds what the user can do about the catalog's most common refusals. */
function explain(error: unknown): Error {
	const message = (error as Error).message ?? String(error);
	if (/SQL Server Authentication/i.test(message)) {
		return new CatalogError(
			`${message}\nSSISDB refuses to start executions or deploy projects for SQL logins. Use a profile with "auth": "ntlm" (a Windows account) or, on Azure-SSIS, "entra".`,
		);
	}
	return error instanceof Error ? error : new CatalogError(message);
}

async function run(db: SqlExecutor, sql: string, params?: Record<string, SqlValue>): Promise<Row[]> {
	try {
		return await db.query(sql, params);
	} catch (error) {
		throw explain(error);
	}
}

export function listFolders(db: SqlExecutor): Promise<Row[]> {
	return run(
		db,
		`SELECT f.name, f.description,
       (SELECT COUNT(*) FROM catalog.projects p WHERE p.folder_id = f.folder_id) AS projects,
       (SELECT COUNT(*) FROM catalog.environments e WHERE e.folder_id = f.folder_id) AS environments
FROM catalog.folders f ORDER BY f.name`,
	);
}

export function listProjects(db: SqlExecutor, folder?: string): Promise<Row[]> {
	return run(
		db,
		`SELECT f.name AS folder, p.name AS project, p.last_deployed_time, p.deployed_by_name, p.object_version_lsn AS version,
       (SELECT COUNT(*) FROM catalog.packages k WHERE k.project_id = p.project_id) AS packages
FROM catalog.projects p JOIN catalog.folders f ON f.folder_id = p.folder_id
WHERE (@folder IS NULL OR f.name = @folder) ORDER BY f.name, p.name`,
		{ folder: folder ?? null },
	);
}

export function listPackages(db: SqlExecutor, folder: string, project: string): Promise<Row[]> {
	return run(
		db,
		`SELECT k.name AS package, k.entry_point, k.description
FROM catalog.packages k JOIN catalog.projects p ON p.project_id = k.project_id JOIN catalog.folders f ON f.folder_id = p.folder_id
WHERE f.name = @folder AND p.name = @project ORDER BY k.name`,
		{ folder, project },
	);
}

export async function listParameters(db: SqlExecutor, folder: string, project: string, pkg?: string): Promise<Row[]> {
	const rows = await run(
		db,
		`SELECT CASE o.object_type WHEN 20 THEN 'project' ELSE 'package' END AS scope, o.object_name, o.parameter_name, o.data_type,
       o.required, o.sensitive, o.value_type, o.default_value, o.design_default_value, o.referenced_variable_name
FROM catalog.object_parameters o JOIN catalog.projects p ON p.project_id = o.project_id JOIN catalog.folders f ON f.folder_id = p.folder_id
WHERE f.name = @folder AND p.name = @project AND (@package IS NULL OR o.object_type = 20 OR o.object_name = @package)
  AND o.parameter_name NOT LIKE 'CM.%'
ORDER BY o.object_type, o.object_name, o.parameter_name`,
		{ folder, project, package: pkg ?? null },
	);
	return rows.map(maskSensitive("default_value", "design_default_value"));
}

function maskSensitive(...fields: string[]) {
	return (row: Row): Row => {
		if (!row.sensitive) return row;
		const masked = { ...row };
		for (const f of fields) if (masked[f] !== null && masked[f] !== undefined) masked[f] = "<sensitive>";
		return masked;
	};
}

export async function listEnvironments(db: SqlExecutor, folder?: string): Promise<{ environments: Row[]; variables: Row[]; references: Row[] }> {
	const params = { folder: folder ?? null };
	const environments = await run(
		db,
		`SELECT f.name AS folder, e.name AS environment, e.description
FROM catalog.environments e JOIN catalog.folders f ON f.folder_id = e.folder_id
WHERE (@folder IS NULL OR f.name = @folder) ORDER BY f.name, e.name`,
		params,
	);
	const variables = await run(
		db,
		`SELECT f.name AS folder, e.name AS environment, v.name AS variable, v.type, v.sensitive, v.value
FROM catalog.environment_variables v JOIN catalog.environments e ON e.environment_id = v.environment_id JOIN catalog.folders f ON f.folder_id = e.folder_id
WHERE (@folder IS NULL OR f.name = @folder) ORDER BY f.name, e.name, v.name`,
		params,
	);
	const references = await run(
		db,
		`SELECT f.name AS folder, p.name AS project, r.environment_name AS environment, r.reference_type, r.environment_folder_name
FROM catalog.environment_references r JOIN catalog.projects p ON p.project_id = r.project_id JOIN catalog.folders f ON f.folder_id = p.folder_id
WHERE (@folder IS NULL OR f.name = @folder) ORDER BY f.name, p.name`,
		params,
	);
	return { environments, variables: variables.map(maskSensitive("value")), references };
}

export interface ExecutionFilter {
	folder?: string;
	project?: string;
	package?: string;
	status?: string;
	sinceHours?: number;
	limit?: number;
}

export async function listExecutions(db: SqlExecutor, filter: ExecutionFilter = {}): Promise<Row[]> {
	const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 20), 1), 200);
	return run(
		db,
		`SELECT TOP (${limit}) e.execution_id, e.folder_name, e.project_name, e.package_name, e.status, e.start_time, e.end_time,
       e.executed_as_name, e.environment_name
FROM catalog.executions e
WHERE (@folder IS NULL OR e.folder_name = @folder) AND (@project IS NULL OR e.project_name = @project)
  AND (@package IS NULL OR e.package_name = @package) AND (@status IS NULL OR e.status = @status)
  AND (@since IS NULL OR e.created_time >= DATEADD(hour, -CAST(@since AS int), SYSDATETIMEOFFSET()))
ORDER BY e.execution_id DESC`,
		{
			folder: filter.folder ?? null,
			project: filter.project ?? null,
			package: filter.package ?? null,
			status: filter.status ? statusCode(filter.status) : null,
			since: filter.sinceHours ?? null,
		},
	);
}

export function executionMessages(db: SqlExecutor, executionId: number, level: "errors" | "warnings" | "all" = "errors", limit = 50): Promise<Row[]> {
	const types = level === "errors" ? "AND m.message_type IN (120, 130)" : level === "warnings" ? "AND m.message_type IN (110, 120, 130)" : "";
	const top = Math.min(Math.max(Math.trunc(limit), 1), 500);
	return run(
		db,
		`SELECT TOP (${top}) m.message_time, m.message_type, m.message_source_name, m.package_name, m.execution_path, m.message
FROM catalog.event_messages m WHERE m.operation_id = @id ${types} ORDER BY m.event_message_id`,
		{ id: executionId },
	);
}

export interface Diagnosis {
	execution?: Row;
	errors: Row[];
	failedTasks: Row[];
	parameters: Row[];
	/** Messages logged against the operation itself (e.g. failures before any task ran). */
	operationMessages: Row[];
}

export async function diagnose(db: SqlExecutor, executionId: number): Promise<Diagnosis> {
	const id = { id: executionId };
	const [execution] = await run(
		db,
		`SELECT e.execution_id, e.folder_name, e.project_name, e.package_name, e.status, e.start_time, e.end_time, e.executed_as_name,
       e.environment_name, e.use32bitruntime, e.server_name
FROM catalog.executions e WHERE e.execution_id = @id`,
		id,
	);
	if (!execution) return { errors: [], failedTasks: [], parameters: [], operationMessages: [] };
	const errors = await executionMessages(db, executionId, "errors", 60);
	const failedTasks = await run(
		db,
		`SELECT x.package_name, x.executable_name, s.execution_path, s.start_time, s.execution_duration
FROM catalog.executable_statistics s JOIN catalog.executables x ON x.executable_id = s.executable_id AND x.execution_id = s.execution_id
WHERE s.execution_id = @id AND s.execution_result = 1 ORDER BY s.start_time`,
		id,
	);
	const parameters = (
		await run(
			db,
			`SELECT CASE v.object_type WHEN 20 THEN 'project' WHEN 30 THEN 'package' ELSE 'system' END AS scope, v.parameter_name, v.parameter_value, v.sensitive
FROM catalog.execution_parameter_values v WHERE v.execution_id = @id AND v.value_set = 1 ORDER BY v.object_type, v.parameter_name`,
			id,
		)
	).map(maskSensitive("parameter_value"));
	const operationMessages = errors.length
		? []
		: await run(db, `SELECT TOP (20) m.message_time, m.message_type, m.message FROM catalog.operation_messages m WHERE m.operation_id = @id AND m.message_type IN (110, 120) ORDER BY m.operation_message_id`, id);
	return { execution, errors, failedTasks, parameters, operationMessages };
}

/** Converts a text value to the JS type the driver maps to the parameter's SSIS data type. */
export function coerce(value: string, dataType: string, name: string): SqlValue {
	const type = dataType.toLowerCase();
	if (type === "boolean") {
		if (/^(true|1|yes)$/i.test(value)) return true;
		if (/^(false|0|no)$/i.test(value)) return false;
		throw new CatalogError(`${name} is Boolean; "${value}" is not true or false.`);
	}
	if (/^(u?int(16|32|64)|s?byte|single|double|decimal)$/.test(type)) {
		const n = Number(value);
		if (value.trim() === "" || Number.isNaN(n)) throw new CatalogError(`${name} is ${dataType}; "${value}" is not a number.`);
		return n;
	}
	if (type === "datetime") {
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) throw new CatalogError(`${name} is DateTime; "${value}" is not a date.`);
		return d;
	}
	return value;
}

/**
 * SQL type a value must have inside the sql_variant the catalog procedures take;
 * they reject values whose variant type does not match the parameter's SSIS type.
 */
export function sqlType(dataType: string): string {
	const types: Record<string, string> = {
		boolean: "bit",
		byte: "tinyint",
		sbyte: "smallint",
		int16: "smallint",
		uint16: "int",
		int32: "int",
		uint32: "bigint",
		int64: "bigint",
		uint64: "decimal(20, 0)",
		single: "real",
		double: "float",
		decimal: "decimal(28, 10)",
		datetime: "datetime2",
	};
	return types[dataType.toLowerCase()] ?? "nvarchar(4000)";
}

export interface ExecutionParameter {
	name: string;
	value: string;
	scope?: "package" | "project";
}

export interface StartOptions {
	folder: string;
	project: string;
	package: string;
	environment?: string;
	environmentFolder?: string;
	parameters?: ExecutionParameter[];
	/** 0 none, 1 basic (default), 2 performance, 3 verbose. */
	loggingLevel?: number;
	use32Bit?: boolean;
}

async function environmentReference(db: SqlExecutor, o: StartOptions): Promise<number> {
	const rows = await run(
		db,
		`SELECT r.reference_id, r.environment_name, r.reference_type, r.environment_folder_name
FROM catalog.environment_references r JOIN catalog.projects p ON p.project_id = r.project_id JOIN catalog.folders f ON f.folder_id = p.folder_id
WHERE f.name = @folder AND p.name = @project`,
		{ folder: o.folder, project: o.project },
	);
	const matches = rows.filter(
		(r) => String(r.environment_name).toLowerCase() === o.environment!.toLowerCase() && (!o.environmentFolder || String(r.environment_folder_name ?? o.folder).toLowerCase() === o.environmentFolder.toLowerCase()),
	);
	if (matches.length === 1) return Number(matches[0]!.reference_id);
	if (!matches.length) {
		const available = rows.map((r) => r.environment_name).join(", ") || "none";
		throw new CatalogError(`Project ${o.folder}/${o.project} has no reference to environment "${o.environment}". Referenced environments: ${available}`);
	}
	throw new CatalogError(`Environment "${o.environment}" is referenced from several folders; pass environmentFolder to choose.`);
}

export async function startExecution(db: SqlExecutor, o: StartOptions): Promise<number> {
	const known = await listParameters(db, o.folder, o.project, o.package);
	const packages = await listPackages(db, o.folder, o.project);
	if (!packages.length) throw new CatalogError(`No project ${o.folder}/${o.project} in the catalog (or it has no packages). Use ssisdb_query view "projects" to list what is deployed.`);
	if (!packages.some((p) => String(p.package).toLowerCase() === o.package.toLowerCase())) {
		throw new CatalogError(`Project ${o.folder}/${o.project} has no package "${o.package}". Packages: ${packages.map((p) => p.package).join(", ")}`);
	}

	const params: Record<string, SqlValue> = { folder: o.folder, project: o.project, package: o.package, use32: o.use32Bit === true, logging: o.loggingLevel ?? 1 };
	const lines = [
		"DECLARE @execution_id bigint;",
		`EXEC catalog.create_execution @folder_name = @folder, @project_name = @project, @package_name = @package, @reference_id = ${o.environment ? "@reference" : "NULL"}, @use32bitruntime = @use32, @execution_id = @execution_id OUTPUT;`,
		"DECLARE @logging_level sql_variant = CAST(@logging AS smallint);",
		"EXEC catalog.set_execution_parameter_value @execution_id, @object_type = 50, @parameter_name = N'LOGGING_LEVEL', @parameter_value = @logging_level;",
	];
	if (o.environment) params.reference = await environmentReference(db, o);

	(o.parameters ?? []).forEach((p, i) => {
		const candidates = known.filter((k) => String(k.parameter_name).toLowerCase() === p.name.toLowerCase() && (!p.scope || k.scope === p.scope));
		const match = candidates.find((k) => k.scope === "package") ?? candidates[0];
		if (!match) {
			throw new CatalogError(`No parameter "${p.name}" on ${o.project}/${o.package}. Parameters: ${known.map((k) => `${k.scope}:${k.parameter_name}`).join(", ") || "none"}`);
		}
		params[`p${i}_name`] = String(match.parameter_name);
		params[`p${i}_value`] = coerce(p.value, String(match.data_type), p.name);
		lines.push(
			`DECLARE @v${i} sql_variant = CAST(@p${i}_value AS ${sqlType(String(match.data_type))});`,
			`EXEC catalog.set_execution_parameter_value @execution_id, @object_type = ${match.scope === "project" ? 20 : 30}, @parameter_name = @p${i}_name, @parameter_value = @v${i};`,
		);
	});
	lines.push("EXEC catalog.start_execution @execution_id;", "SELECT @execution_id AS execution_id;");

	const rows = await run(db, lines.join("\n"), params);
	const id = Number(rows[0]?.execution_id);
	if (!Number.isFinite(id)) throw new CatalogError("The catalog did not return an execution id.");
	return id;
}

export async function executionStatus(db: SqlExecutor, executionId: number): Promise<Row | undefined> {
	const [row] = await run(db, "SELECT e.execution_id, e.status, e.start_time, e.end_time FROM catalog.executions e WHERE e.execution_id = @id", { id: executionId });
	return row;
}

export interface WaitOptions {
	timeoutSeconds?: number;
	pollSeconds?: number;
	signal?: AbortSignal;
	sleep?: (ms: number) => Promise<void>;
	onPoll?: (status: string) => void;
}

/** Polls until the execution leaves an active state. Returns the last status seen and whether it finished. */
export async function waitForExecution(db: SqlExecutor, executionId: number, options: WaitOptions = {}): Promise<{ status: string; finished: boolean }> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = Date.now() + (options.timeoutSeconds ?? 300) * 1000;
	for (;;) {
		const row = await executionStatus(db, executionId);
		const code = Number(row?.status);
		const status = STATUS[code] ?? `status ${code}`;
		if (!ACTIVE.has(code)) return { status, finished: true };
		options.onPoll?.(status);
		if (options.signal?.aborted || Date.now() >= deadline) return { status, finished: false };
		await sleep((options.pollSeconds ?? 3) * 1000);
	}
}

export async function stopExecution(db: SqlExecutor, executionId: number): Promise<void> {
	await run(db, "EXEC catalog.stop_operation @operation_id = @id;", { id: executionId });
}

export interface DeployOptions {
	ispacPath: string;
	folder: string;
	/** Must match the project name inside the .ispac; read from it when omitted. */
	project?: string;
	createFolder?: boolean;
}

export async function deployProject(db: SqlExecutor, o: DeployOptions): Promise<{ operationId: number; project: string; status: string; messages: Row[] }> {
	const embedded = loadProject(o.ispacPath);
	const project = o.project ?? embedded.name;
	if (!project) throw new CatalogError(`Could not read the project name from ${o.ispacPath}; pass project explicitly.`);
	if (embedded.name && embedded.name !== project) {
		throw new CatalogError(`The .ispac contains project "${embedded.name}"; the catalog requires the deployed name to match, so "${project}" would be rejected.`);
	}
	const folders = await run(db, "SELECT f.name FROM catalog.folders f WHERE f.name = @folder", { folder: o.folder });
	if (!folders.length) {
		if (!o.createFolder) throw new CatalogError(`Catalog folder "${o.folder}" does not exist. Pass createFolder to create it.`);
		await run(db, "EXEC catalog.create_folder @folder_name = @folder;", { folder: o.folder });
	}
	const rows = await run(
		db,
		`DECLARE @operation_id bigint;
EXEC catalog.deploy_project @folder_name = @folder, @project_name = @project, @project_stream = @stream, @operation_id = @operation_id OUTPUT;
SELECT @operation_id AS operation_id;`,
		{ folder: o.folder, project, stream: readFileSync(o.ispacPath) },
	);
	const operationId = Number(rows[0]?.operation_id);
	const [operation] = await run(db, "SELECT o.status FROM catalog.operations o WHERE o.operation_id = @id", { id: operationId });
	const status = STATUS[Number(operation?.status)] ?? "unknown";
	const messages = status === "succeeded" ? [] : await run(db, "SELECT m.message_time, m.message_type, m.message FROM catalog.operation_messages m WHERE m.operation_id = @id ORDER BY m.operation_message_id", { id: operationId });
	return { operationId, project, status, messages };
}

export interface SetParameterOptions {
	folder: string;
	project: string;
	package?: string;
	name: string;
	value?: string;
	/** Bind the parameter to an environment variable instead of a literal. */
	referencedVariable?: string;
}

export async function setParameter(db: SqlExecutor, o: SetParameterOptions): Promise<{ scope: string; dataType: string }> {
	if ((o.value === undefined) === (o.referencedVariable === undefined)) throw new CatalogError("Pass exactly one of value or referencedVariable.");
	const known = await listParameters(db, o.folder, o.project, o.package);
	const wanted = o.package ? "package" : "project";
	const match = known.find((k) => String(k.parameter_name).toLowerCase() === o.name.toLowerCase() && k.scope === wanted);
	if (!match) {
		throw new CatalogError(`No ${wanted} parameter "${o.name}" on ${o.folder}/${o.project}${o.package ? `/${o.package}` : ""}. Parameters: ${known.map((k) => `${k.scope}:${k.parameter_name}`).join(", ") || "none"}`);
	}
	const dataType = String(match.data_type);
	await run(
		db,
		`DECLARE @v sql_variant = CAST(@value AS ${o.referencedVariable ? "nvarchar(4000)" : sqlType(dataType)});
EXEC catalog.set_object_parameter_value @object_type = ${wanted === "project" ? 20 : 30}, @folder_name = @folder, @project_name = @project, @parameter_name = @name, @parameter_value = @v, @object_name = @object, @value_type = @value_type;`,
		{
			folder: o.folder,
			project: o.project,
			name: String(match.parameter_name),
			value: o.referencedVariable ?? coerce(o.value!, dataType, o.name),
			object: o.package ?? o.project,
			value_type: o.referencedVariable ? "R" : "V",
		},
	);
	return { scope: wanted, dataType };
}

export async function setEnvironmentVariable(db: SqlExecutor, o: { folder: string; environment: string; name: string; value: string }): Promise<{ dataType: string }> {
	const { variables } = await listEnvironments(db, o.folder);
	const inEnvironment = variables.filter((v) => String(v.environment).toLowerCase() === o.environment.toLowerCase());
	const match = inEnvironment.find((v) => String(v.variable).toLowerCase() === o.name.toLowerCase());
	if (!match) {
		throw new CatalogError(`Environment ${o.folder}/${o.environment} has no variable "${o.name}". Variables: ${inEnvironment.map((v) => v.variable).join(", ") || "none (or the environment does not exist)"}`);
	}
	const dataType = String(match.type);
	await run(db, `DECLARE @v sql_variant = CAST(@value AS ${sqlType(dataType)});\nEXEC catalog.set_environment_variable_value @folder_name = @folder, @environment_name = @environment, @variable_name = @name, @value = @v;`, {
		folder: o.folder,
		environment: String(match.environment),
		name: String(match.variable),
		value: coerce(o.value, dataType, o.name),
	});
	return { dataType };
}

// ---- rendering ----

function time(value: unknown): string {
	if (value instanceof Date) return `${value.toISOString().replace("T", " ").slice(0, 19)}Z`;
	return value === null || value === undefined ? "" : String(value);
}

function duration(start: unknown, end: unknown): string {
	if (!(start instanceof Date) || !(end instanceof Date)) return "";
	const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
	return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

export function renderRows(rows: Row[], empty: string): string {
	if (!rows.length) return empty;
	return rows
		.map((row) =>
			`- ${Object.entries(row)
				.filter(([, v]) => v !== null && v !== undefined && v !== "")
				.map(([k, v]) => `${k}=${v instanceof Date ? time(v) : String(v)}`)
				.join(", ")}`,
		)
		.join("\n");
}

export function renderExecutions(rows: Row[]): string {
	if (!rows.length) return "No executions match.";
	return rows
		.map((e) => {
			const took = duration(e.start_time, e.end_time);
			return `- #${e.execution_id} ${STATUS[Number(e.status)] ?? e.status}  ${e.folder_name}/${e.project_name}/${e.package_name}  started ${time(e.start_time)}${took ? ` (${took})` : ""}${e.environment_name ? `  env ${e.environment_name}` : ""}  by ${e.executed_as_name}`;
		})
		.join("\n");
}

/** SSIS repeats each error once per enclosing container; keep the first of each. */
function dedupeMessages(rows: Row[]): Row[] {
	const seen = new Set<string>();
	return rows.filter((r) => {
		const key = String(r.message);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function renderMessages(rows: Row[]): string {
	if (!rows.length) return "No messages at this level.";
	return dedupeMessages(rows)
		.map((m) => `- ${time(m.message_time)} [${MESSAGE_TYPES[Number(m.message_type)] ?? m.message_type}] ${m.execution_path ?? m.message_source_name ?? ""}\n    ${String(m.message).trim().replace(/\r?\n/g, "\n    ")}`)
		.join("\n");
}

export function renderDiagnosis(d: Diagnosis, executionId: number): string {
	if (!d.execution) return `No execution #${executionId} in the catalog.`;
	const e = d.execution;
	const took = duration(e.start_time, e.end_time);
	const out = [
		`# Execution #${e.execution_id}: ${STATUS[Number(e.status)] ?? e.status}`,
		`${e.folder_name}/${e.project_name}/${e.package_name} on ${e.server_name ?? "?"}`,
		`started ${time(e.start_time)}${took ? `, ran ${took}` : ""}, as ${e.executed_as_name}${e.environment_name ? `, environment ${e.environment_name}` : ""}${e.use32bitruntime ? ", 32-bit runtime" : ""}`,
	];
	if (d.failedTasks.length) {
		out.push("", "## Failed tasks (innermost last)", ...d.failedTasks.map((t) => `- ${t.execution_path} (${t.package_name}, ${t.execution_duration} ms)`));
	}
	if (d.errors.length) out.push("", "## Errors", renderMessages(d.errors));
	else if (d.operationMessages.length) out.push("", "## Operation messages", renderMessages(d.operationMessages));
	else if (Number(e.status) === 4 || Number(e.status) === 6) out.push("", "No error messages were logged. The logging level may have been None, or the process was killed; check the Windows event log on the server.");
	if (d.parameters.length) {
		out.push("", "## Parameter values set for this run", ...d.parameters.map((p) => `- ${p.scope}:${p.parameter_name} = ${p.parameter_value}`));
	}
	return out.join("\n");
}
