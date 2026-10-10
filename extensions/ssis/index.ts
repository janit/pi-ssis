/**
 * pi-ssis: SQL Server Integration Services tools for pi.
 *
 * Offline tools read, search, validate, edit and assess .dtsx packages.
 * Catalog tools talk to an SSISDB over a configured connection profile;
 * every one that changes the server asks the user first.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeProfile, loadConfig, pickProfile, type Profile } from "../../src/catalog/config.ts";
import { connect, type SqlExecutor } from "../../src/catalog/executor.ts";
import { EDIT_OPS } from "../../src/edit/ops.ts";
import { confirmWrite } from "../../src/guard.ts";
import * as tools from "../../src/tools.ts";

const ALLOW_WRITE_FLAG = "ssis-allow-write";

const PATH = Type.String({ description: "Path to a .dtsx package, or Project.ispac!Package.dtsx for a package inside a deployment file. Relative paths resolve from the working directory." });
const DETAIL = Type.Optional(Type.Union([Type.Literal("outline"), Type.Literal("full")], { description: "outline (default) shortens long SQL and omits script source; full shows everything." }));
const PROFILE = Type.Optional(Type.String({ description: "Connection profile name from .pi/ssis.json. Omit to use the active/default profile." }));

async function shorten(text: string): Promise<string> {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return text;
	const file = join(await mkdtemp(join(tmpdir(), "pi-ssis-")), "output.txt");
	await writeFile(file, text, "utf8");
	return `${truncation.content}\n\n[Output truncated at ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}. Full output: ${file}]`;
}

export default function (pi: ExtensionAPI) {
	/** Profile chosen with /ssis for this session; falls back to the configured default. */
	let activeProfile: string | undefined;
	const connections = new Map<string, Promise<SqlExecutor>>();

	pi.registerFlag(ALLOW_WRITE_FLAG, {
		description: "Allow SSISDB changes (execute, stop, deploy, set parameter) when no UI is available to confirm them",
		type: "boolean",
		default: false,
	});

	async function database(cwd: string, requested?: string): Promise<{ db: SqlExecutor; profile: Profile }> {
		const profile = pickProfile(loadConfig(cwd), requested ?? activeProfile, cwd);
		let pending = connections.get(profile.name);
		if (!pending) {
			pending = connect(profile);
			connections.set(profile.name, pending);
			// A failed connection must not be cached, or every later call would repeat the same error.
			pending.catch(() => connections.delete(profile.name));
		}
		return { db: await pending, profile };
	}

	function env(ctx: ExtensionContext, signal?: AbortSignal, progress?: (text: string) => void): tools.ToolEnv {
		return {
			cwd: ctx.cwd,
			signal,
			progress,
			confirm: (title, message) =>
				confirmWrite({ hasUI: ctx.hasUI, confirm: (t, m) => ctx.ui.confirm(t, m), allowWrite: pi.getFlag(ALLOW_WRITE_FLAG) === true }, title, message),
			database: (profile) => database(ctx.cwd, profile),
			withFileLock: (path, fn) => withFileMutationQueue(path, fn),
		};
	}

	const text = async (value: string | Promise<string>) => ({ content: [{ type: "text" as const, text: await shorten(await value) }], details: undefined });

	// ---- offline: read ----

	pi.registerTool({
		name: "ssis_overview",
		label: "SSIS overview",
		description: "Summarise an SSIS project: its packages (task counts, connections used, child packages called), project connection managers and project parameters. Accepts a directory of .dtsx files or an .ispac deployment file. Start here when asked about an SSIS project.",
		promptSnippet: "Summarise an SSIS project directory or .ispac",
		promptGuidelines: [
			"Use the ssis_* tools instead of reading .dtsx files directly; raw DTSX XML is very large and the tools return the same information compactly.",
		],
		parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Directory containing .dtsx files, or an .ispac file. Defaults to the working directory." })) }),
		annotations: { readOnlyHint: true, openWorldHint: false },
		execute: async (_id, params, _signal, _onUpdate, ctx) => text(tools.overview(env(ctx), params)),
	});

	pi.registerTool({
		name: "ssis_package",
		label: "SSIS package",
		description: "Show one SSIS package: connections, parameters, variables and the control flow in execution order with each task's SQL, expressions, loop settings and precedence constraints. Data flows are summarised; use ssis_dataflow for their detail.",
		promptSnippet: "Show an SSIS package's control flow, SQL, variables and connections",
		parameters: Type.Object({ path: PATH, detail: DETAIL }),
		annotations: { readOnlyHint: true, openWorldHint: false },
		execute: async (_id, params, _signal, _onUpdate, ctx) => text(tools.packageOutline(env(ctx), params)),
	});

	pi.registerTool({
		name: "ssis_dataflow",
		label: "SSIS data flow",
		description: "Show the inside of a data flow task: components from source to destination, their settings (queries, tables), derived-column and split expressions, column lists with types, and destination column mappings.",
		promptSnippet: "Show an SSIS data flow's components, columns and mappings",
		parameters: Type.Object({
			path: PATH,
			task: Type.Optional(Type.String({ description: "Name or refId of the data flow task. Omit to show all data flows in the package." })),
			detail: DETAIL,
		}),
		annotations: { readOnlyHint: true, openWorldHint: false },
		execute: async (_id, params, _signal, _onUpdate, ctx) => text(tools.dataFlow(env(ctx), params)),
	});

	pi.registerTool({
		name: "ssis_search",
		label: "SSIS search",
		description: "Find where something is used across SSIS packages: a table, column, variable, parameter, connection, file path or any text in SQL, expressions, scripts and settings. Returns the task or component and the field for each match. Use for impact analysis and lineage questions.",
		promptSnippet: "Find where a table, variable or text is used across SSIS packages",
		parameters: Type.Object({
			query: Type.String({ description: "Text to find (case-insensitive), e.g. dbo.Customer or User::BatchId." }),
			path: Type.Optional(Type.String({ description: "A project directory, .ispac or single .dtsx. Defaults to the working directory." })),
			regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression." })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: false },
		execute: async (_id, params, _signal, _onUpdate, ctx) => text(tools.search(env(ctx), params)),
	});

	pi.registerTool({
		name: "ssis_validate",
		label: "SSIS validate",
		description: "Check a package's structure: duplicate ids and names, precedence constraints that point nowhere or form a cycle, unresolved connections, broken data flow paths and column lineage, references to undeclared variables. Structural only; it cannot tell whether the package runs.",
		parameters: Type.Object({ path: PATH }),
		annotations: { readOnlyHint: true, openWorldHint: false },
		execute: async (_id, params, _signal, _onUpdate, ctx) => text(tools.validate(env(ctx), params)),
	});

	// ---- offline: edit ----

	const optionalString = (description: string) => Type.Optional(Type.String({ description }));
	pi.registerTool({
		name: "ssis_edit",
		label: "SSIS edit",
		description: `Change an SSIS package (.dtsx, format 2012+) or project connection manager (.conmgr) safely. Applies operations in order, validates the result and writes only if the package is still structurally sound; nothing is written if any operation fails. Only the affected lines change. Operations and their fields:
- set_sql: target, sql — statement of an Execute SQL task, or SqlCommand of a data flow source
- set_property: target, property, value — a task, component or connection property
- set_connection_string: connection, value
- set_expression: target, property, expression — omit expression to remove it
- set_disabled: target, disabled
- add_variable: name, dataType?, value?, expression?, namespace?, scope?
- remove_variable: name, scope?, force?
- rename_variable: name, newName — also updates references
- add_parameter: name, dataType?, value?, required?, description?
- remove_parameter: name, force?
- rename_parameter: name, newName
- add_execute_sql_task: name, connection, sql, parent?, after?
- add_constraint: from, to, value? (success|failure|completion), expression?, combine? (and|or|expression_only), logicalAnd?
- remove_constraint: from, to
Targets are task names or refIds as shown by ssis_package. Adding data flow components is not supported; do that in Visual Studio.`,
		promptSnippet: "Edit an SSIS package safely (SQL, properties, variables, parameters, tasks, constraints)",
		promptGuidelines: ["Change .dtsx files with ssis_edit rather than a text edit tool: it keeps ids and references consistent and refuses edits that would break the package."],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .dtsx or .conmgr file to change." }),
			operations: Type.Array(
				Type.Object({
					op: Type.Union(EDIT_OPS.map((op) => Type.Literal(op)), { description: "Operation to perform." }),
					target: optionalString("Task, container, data flow component or connection: name or refId."),
					connection: optionalString("Connection manager name."),
					name: optionalString("Name of the variable, parameter or new task."),
					newName: optionalString("New name, for rename operations."),
					sql: optionalString("SQL text."),
					property: optionalString("Property name."),
					value: optionalString("New value. For add_constraint: success, failure or completion."),
					expression: optionalString("SSIS expression."),
					dataType: optionalString("String (default), Int32, Int64, Boolean, DateTime, Decimal, Double, Object, ..."),
					namespace: optionalString("Variable namespace, default User."),
					scope: optionalString("Container that owns the variable; default is the package."),
					parent: optionalString("Container to add the new task to; default is the package."),
					after: optionalString("Existing task the new task should run after (adds a success constraint)."),
					from: optionalString("Constraint start task."),
					to: optionalString("Constraint end task."),
					combine: optionalString("How expression and outcome combine: and (default), or, expression_only."),
					description: optionalString("Parameter description."),
					disabled: Type.Optional(Type.Boolean()),
					required: Type.Optional(Type.Boolean()),
					logicalAnd: Type.Optional(Type.Boolean({ description: "false makes multiple incoming constraints OR together." })),
					force: Type.Optional(Type.Boolean({ description: "Remove even though references remain." })),
				}),
				{ description: "Operations to apply, in order." },
			),
			dryRun: Type.Optional(Type.Boolean({ description: "Validate and report without writing the file." })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		execute: async (_id, params, _signal, _onUpdate, ctx) => text(tools.edit(env(ctx), params)),
	});

	// ---- offline: migration ----

	pi.registerTool({
		name: "ssis_migration_inventory",
		label: "SSIS migration inventory",
		description: "Assess a package or whole project for migration away from SSIS: each task and data flow described in target-neutral terms with a complexity rating, what cannot be converted mechanically (scripts, third-party components, Excel, MSDTC transactions), environment-bound connections, and a suggested package order. Use before planning or writing a conversion.",
		promptSnippet: "Assess SSIS packages for migration to another stack",
		parameters: Type.Object({ path: Type.Optional(Type.String({ description: "A .dtsx package for task-level detail, or a directory/.ispac for a project summary. Defaults to the working directory." })) }),
		annotations: { readOnlyHint: true, openWorldHint: false },
		execute: async (_id, params, _signal, _onUpdate, ctx) => text(tools.migrationInventory(env(ctx), params)),
	});

	// ---- SSISDB catalog ----

	pi.registerTool({
		name: "ssisdb_query",
		label: "SSISDB query",
		description: `Read the SSIS catalog (SSISDB) on a SQL Server. Views:
- folders; projects (folder?); packages (folder, project); parameters (folder, project, package?)
- environments (folder?): environments, their variables and which projects reference them
- executions (folder?, project?, package?, status?, sinceHours?, limit?): recent runs, newest first
- messages (executionId, level?): logged messages for a run
- diagnose (executionId): why a run failed — failed tasks, error messages, parameter values used
Sensitive values are never returned. Needs a connection profile; run /ssis to see or choose one.`,
		promptSnippet: "Read the SSISDB catalog: deployed projects, executions, failure diagnosis",
		parameters: Type.Object({
			view: Type.Union(
				["folders", "projects", "packages", "parameters", "environments", "executions", "messages", "diagnose"].map((v) => Type.Literal(v)),
				{ description: "What to read." },
			),
			folder: Type.Optional(Type.String()),
			project: Type.Optional(Type.String()),
			package: Type.Optional(Type.String({ description: "Package name including .dtsx." })),
			executionId: Type.Optional(Type.Number()),
			status: Type.Optional(Type.String({ description: "running, failed, succeeded, canceled, pending, created, stopping, completed or ended unexpectedly." })),
			sinceHours: Type.Optional(Type.Number({ description: "Only executions created in the last N hours." })),
			limit: Type.Optional(Type.Number({ description: "Maximum rows (default 20 executions / 50 messages)." })),
			level: Type.Optional(Type.Union([Type.Literal("errors"), Type.Literal("warnings"), Type.Literal("all")])),
			profile: PROFILE,
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		execute: async (_id, params, signal, _onUpdate, ctx) => text(tools.catalogQuery(env(ctx, signal), params as tools.QueryParams)),
	});

	pi.registerTool({
		name: "ssisdb_execute",
		label: "SSISDB execute",
		description: "Start a deployed package in the SSIS catalog and, by default, wait for the outcome (a failure is diagnosed automatically). The user is asked to confirm. Parameter values are checked against the deployed parameter types before anything starts.",
		parameters: Type.Object({
			folder: Type.String(),
			project: Type.String(),
			package: Type.String({ description: "Package name including .dtsx." }),
			environment: Type.Optional(Type.String({ description: "Environment to run with; the project must already reference it." })),
			environmentFolder: Type.Optional(Type.String({ description: "Folder of the environment, if the same name is referenced from several folders." })),
			parameters: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String(),
						value: Type.String(),
						scope: Type.Optional(Type.Union([Type.Literal("package"), Type.Literal("project")])),
					}),
					{ description: "Parameter overrides for this run only." },
				),
			),
			loggingLevel: Type.Optional(Type.Number({ description: "0 none, 1 basic (default), 2 performance, 3 verbose." })),
			use32Bit: Type.Optional(Type.Boolean()),
			wait: Type.Optional(Type.Boolean({ description: "Wait for completion (default true)." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "How long to wait before returning while it keeps running (default 120)." })),
			profile: PROFILE,
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		execute: async (_id, params, signal, onUpdate, ctx) =>
			text(tools.catalogExecute(env(ctx, signal, (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined })), params)),
	});

	pi.registerTool({
		name: "ssisdb_stop",
		label: "SSISDB stop",
		description: "Stop a running SSIS catalog execution. The user is asked to confirm.",
		parameters: Type.Object({ executionId: Type.Number(), profile: PROFILE }),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		execute: async (_id, params, signal, _onUpdate, ctx) => text(tools.catalogStop(env(ctx, signal), params)),
	});

	pi.registerTool({
		name: "ssisdb_deploy",
		label: "SSISDB deploy",
		description: "Deploy an .ispac project deployment file to an SSIS catalog folder, replacing the project if it is already there. The user is asked to confirm. On-premises catalogs require a Windows-authenticated (ntlm) profile.",
		parameters: Type.Object({
			ispac: Type.String({ description: "Path to the .ispac file." }),
			folder: Type.String({ description: "Catalog folder to deploy into." }),
			project: Type.Optional(Type.String({ description: "Project name; must match the name inside the .ispac (read from it when omitted)." })),
			createFolder: Type.Optional(Type.Boolean({ description: "Create the catalog folder if it does not exist." })),
			profile: PROFILE,
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		execute: async (_id, params, signal, _onUpdate, ctx) => text(tools.catalogDeploy(env(ctx, signal), params)),
	});

	pi.registerTool({
		name: "ssisdb_set_parameter",
		label: "SSISDB set parameter",
		description: "Change a server-side default in the SSIS catalog: a project or package parameter (literal value, or bound to an environment variable with referencedVariable), or an environment variable's value (pass environment). The user is asked to confirm. Affects future executions.",
		parameters: Type.Object({
			folder: Type.String(),
			project: Type.Optional(Type.String({ description: "Project owning the parameter." })),
			package: Type.Optional(Type.String({ description: "Package owning the parameter; omit for a project parameter." })),
			environment: Type.Optional(Type.String({ description: "Set a variable of this environment instead of a parameter." })),
			name: Type.String({ description: "Parameter or environment variable name." }),
			value: Type.Optional(Type.String()),
			referencedVariable: Type.Optional(Type.String({ description: "Environment variable the parameter should take its value from." })),
			profile: PROFILE,
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		execute: async (_id, params, signal, _onUpdate, ctx) => text(tools.catalogSetParameter(env(ctx, signal), params)),
	});

	// ---- /ssis: connection profiles ----

	pi.registerCommand("ssis", {
		description: "Show or choose the SSISDB connection profile; `/ssis test` checks the connection",
		handler: async (args, ctx) => {
			try {
				const config = loadConfig(ctx.cwd);
				if (args.trim() === "test") {
					const { db, profile } = await database(ctx.cwd);
					const [row] = await db.query("SELECT @@SERVERNAME AS server, SUSER_SNAME() AS login, (SELECT property_value FROM catalog.catalog_properties WHERE property_name = 'SCHEMA_VERSION') AS schema_version");
					ctx.ui.notify(`Connected with ${profile.name}: server ${row?.server}, login ${row?.login}, catalog schema ${row?.schema_version}`, "info");
					return;
				}
				const current = pickProfile(config, activeProfile, ctx.cwd);
				if (config.profiles.length > 1 && ctx.hasUI) {
					const labels = config.profiles.map(describeProfile);
					const choice = await ctx.ui.select(`SSISDB profile (current: ${current.name})`, labels);
					if (choice) activeProfile = config.profiles[labels.indexOf(choice)]!.name;
				}
				const chosen = pickProfile(config, activeProfile, ctx.cwd);
				ctx.ui.setStatus("ssis", `ssis: ${chosen.name}`);
				ctx.ui.notify(`SSISDB profile ${describeProfile(chosen)} (from ${chosen.source})`, "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});

	pi.on("session_shutdown", async () => {
		const open = [...connections.values()];
		connections.clear();
		await Promise.all(open.map((pending) => pending.then((db) => db.close()).catch(() => undefined)));
	});
}
