import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import * as catalog from "./catalog/catalog.ts";
import type { Profile } from "./catalog/config.ts";
import { describeProfile } from "./catalog/config.ts";
import type { SqlExecutor } from "./catalog/executor.ts";
import { collectFacts, searchFacts } from "./dtsx/facts.ts";
import { type Executable, findExecutable, type Package, walk } from "./dtsx/model.ts";
import { loadPackage, loadProject, type Project } from "./dtsx/project.ts";
import { applyEdits, checkOps } from "./edit/ops.ts";
import { renderIssues, validatePackage } from "./edit/validate.ts";
import { buildInventory, renderInventory, renderProjectInventory } from "./migration/inventory.ts";
import { renderDataFlow } from "./render/dataflow.ts";
import { renderPackage, renderProject } from "./render/package.ts";

/**
 * Tool implementations, free of any pi dependency so they can be tested and
 * reused. Each returns the text shown to the model.
 */

export interface ToolEnv {
	cwd: string;
	/** Asks the user before a server change; rejects when they decline or cannot be asked. */
	confirm(title: string, message: string): Promise<void>;
	/** Opens (or reuses) a catalog connection for the named or active profile. */
	database(profile?: string): Promise<{ db: SqlExecutor; profile: Profile }>;
	signal?: AbortSignal;
	progress?(text: string): void;
	/** Serialises writes to a file; defaults to running the callback directly. */
	withFileLock?<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

export class ToolError extends Error {}

/** Resolves a user-supplied path, keeping any `archive.ispac!Package.dtsx` suffix intact. */
export function resolvePath(cwd: string, path: string | undefined): string {
	const cleaned = (path ?? ".").trim().replace(/^@/, "");
	const bang = cleaned.toLowerCase().indexOf(".ispac!");
	if (bang !== -1) return `${resolvePath(cwd, cleaned.slice(0, bang + 6))}${cleaned.slice(bang + 6)}`;
	return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}

function isProjectPath(path: string): boolean {
	if (path.toLowerCase().includes(".ispac!")) return false;
	if (/\.ispac$/i.test(path)) return true;
	return existsSync(path) && statSync(path).isDirectory();
}

export function overview(env: ToolEnv, p: { path?: string }): string {
	return renderProject(loadProject(resolvePath(env.cwd, p.path)));
}

export function packageOutline(env: ToolEnv, p: { path: string; detail?: "outline" | "full" }): string {
	const path = resolvePath(env.cwd, p.path);
	if (isProjectPath(path)) {
		const project = loadProject(path);
		throw new ToolError(`${p.path} is a project. Pass one of its packages: ${packageList(project, path)}`);
	}
	return renderPackage(loadPackage(path).package, { detail: p.detail });
}

function packageList(project: Project, root: string): string {
	const sep = project.kind === "ispac" ? "!" : "/";
	return project.packages.map((k) => `${root}${sep}${k.file}`).join(", ") || "(no packages found)";
}

function dataFlows(pkg: Package): Executable[] {
	const flows: Executable[] = [];
	walk(pkg.root, (e) => {
		if (e.dataFlow) flows.push(e);
	});
	return flows;
}

export function dataFlow(env: ToolEnv, p: { path: string; task?: string; detail?: "outline" | "full" }): string {
	const pkg = loadPackage(resolvePath(env.cwd, p.path)).package;
	const flows = dataFlows(pkg);
	if (!flows.length) return `Package ${pkg.name} has no data flow tasks.`;
	if (p.task) {
		const task = findExecutable(pkg, p.task);
		if (!task) throw new ToolError(`No task "${p.task}". Data flow tasks: ${flows.map((f) => f.refId).join(", ")}`);
		return renderDataFlow(task, { detail: p.detail });
	}
	if (flows.length > 3) {
		return `Package ${pkg.name} has ${flows.length} data flow tasks. Pass task to choose one:\n${flows.map((f) => `- ${f.refId} (${f.dataFlow!.components.length} components)`).join("\n")}`;
	}
	return flows.map((f) => renderDataFlow(f, { detail: p.detail })).join("\n\n");
}

export function search(env: ToolEnv, p: { query: string; path?: string; regex?: boolean }): string {
	const path = resolvePath(env.cwd, p.path);
	if (p.regex) {
		try {
			new RegExp(p.query);
		} catch (error) {
			throw new ToolError(`Invalid regular expression: ${(error as Error).message}`);
		}
	}
	const sources: { label: string; pkg: Package }[] = [];
	const skipped: string[] = [];
	if (isProjectPath(path)) {
		const project = loadProject(path);
		for (const entry of project.packages) {
			if (entry.package) sources.push({ label: entry.file, pkg: entry.package });
			else skipped.push(entry.file);
		}
	} else {
		const loaded = loadPackage(path);
		sources.push({ label: relative(env.cwd, path) || path, pkg: loaded.package });
	}

	const lines: string[] = [];
	let total = 0;
	for (const { label, pkg } of sources) {
		const hits = searchFacts(collectFacts(pkg), p.query, { regex: p.regex });
		if (!hits.length) continue;
		total += hits.length;
		lines.push(`${label} (${hits.length})`);
		for (const h of hits.slice(0, 40)) lines.push(`  ${h.where} [${h.field}]: ${h.excerpt}`);
		if (hits.length > 40) lines.push(`  … ${hits.length - 40} more in this package`);
	}
	const tail = skipped.length ? `\nNot searched (unreadable): ${skipped.join(", ")}` : "";
	if (!total) return `No matches for "${p.query}" in ${sources.length} package(s).${tail}`;
	return `${total} match(es) in ${sources.length} package(s) searched\n${lines.join("\n")}${tail}`;
}

export function validate(env: ToolEnv, p: { path: string }): string {
	const loaded = loadPackage(resolvePath(env.cwd, p.path));
	const projectConnections = loaded.package.connections.filter((c) => c.scope === "project");
	const { issues } = validatePackage(loaded.source, { projectConnections });
	return `${loaded.package.name}: ${renderIssues(issues)}\nThese are structural checks (ids, references, graph shape). They do not prove the package runs; only SSIS can validate metadata against live databases.`;
}

function changedLines(before: string, after: string): { removed: number; added: number } {
	const count = (text: string) => text.split("\n").reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
	const a = count(before);
	const b = count(after);
	let removed = 0;
	let added = 0;
	for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
	for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
	return { removed, added };
}

export async function edit(env: ToolEnv, p: { path: string; operations: unknown[]; dryRun?: boolean }): Promise<string> {
	const path = resolvePath(env.cwd, p.path);
	if (path.toLowerCase().includes(".ispac")) {
		throw new ToolError("Packages inside an .ispac cannot be edited in place. Edit the .dtsx in the project folder and rebuild the .ispac.");
	}
	if (!existsSync(path)) throw new ToolError(`File not found: ${p.path}`);
	const ops = checkOps(p.operations);
	const lock = env.withFileLock ?? ((_path: string, fn: () => Promise<string>) => fn());

	return lock(path, async () => {
		const raw = readFileSync(path);
		if (raw[0] === 0xff && raw[1] === 0xfe) throw new ToolError("This file is UTF-16 encoded. Re-save it as UTF-8 in Visual Studio before editing.");
		const source = raw.toString("utf8");
		const isPackage = /\.dtsx$/i.test(path);
		const projectConnections = isPackage ? loadPackage(path).package.connections.filter((c) => c.scope === "project") : [];
		const result = applyEdits(source, ops, { projectConnections });
		const { removed, added } = changedLines(source, result.source);
		if (result.source === source) return "No change: the file already has these values.";
		if (!p.dryRun) writeFileSync(path, result.source, "utf8");

		const out = [`${p.dryRun ? "Dry run, nothing written" : "Saved"}: ${ops.length} operation(s) on ${relative(env.cwd, path) || path} (${removed} line(s) removed, ${added} added).`];
		for (const note of result.notes) out.push(`Note: ${note}`);
		const warnings = result.issues.filter((i) => i.severity === "warning");
		const errors = result.issues.filter((i) => i.severity === "error");
		if (errors.length) out.push(`Pre-existing structural errors remain (not caused by this edit):\n${errors.map((i) => `- ${i.where}: ${i.message}`).join("\n")}`);
		if (warnings.length) out.push(`Warnings:\n${warnings.map((i) => `- ${i.where}: ${i.message}`).join("\n")}`);
		out.push("Structure was checked; the package has not been run. Open it in Visual Studio or deploy to a test catalog to confirm.");
		return out.join("\n");
	});
}

export function migrationInventory(env: ToolEnv, p: { path?: string }): string {
	const path = resolvePath(env.cwd, p.path);
	if (isProjectPath(path)) return renderProjectInventory(loadProject(path));
	return renderInventory(buildInventory(loadPackage(path).package));
}

// ---- catalog ----

export type CatalogView = "folders" | "projects" | "packages" | "parameters" | "environments" | "executions" | "messages" | "diagnose";

export interface QueryParams {
	view: CatalogView;
	folder?: string;
	project?: string;
	package?: string;
	executionId?: number;
	status?: string;
	sinceHours?: number;
	limit?: number;
	level?: "errors" | "warnings" | "all";
	profile?: string;
}

function need<T extends object>(p: T, view: string, ...fields: (keyof T)[]): void {
	const missing = fields.filter((f) => p[f] === undefined || p[f] === null || p[f] === "");
	if (missing.length) throw new ToolError(`view "${view}" needs: ${missing.join(", ")}`);
}

export async function catalogQuery(env: ToolEnv, p: QueryParams): Promise<string> {
	const { db, profile } = await env.database(p.profile);
	const header = `[${profile.name}: ${profile.server}]\n`;
	switch (p.view) {
		case "folders":
			return header + catalog.renderRows(await catalog.listFolders(db), "The catalog has no folders.");
		case "projects":
			return header + catalog.renderRows(await catalog.listProjects(db, p.folder), "No projects deployed.");
		case "packages":
			need(p, p.view, "folder", "project");
			return header + catalog.renderRows(await catalog.listPackages(db, p.folder!, p.project!), `No project ${p.folder}/${p.project}, or it has no packages.`);
		case "parameters":
			need(p, p.view, "folder", "project");
			return header + catalog.renderRows(await catalog.listParameters(db, p.folder!, p.project!, p.package), "No parameters.");
		case "environments": {
			const e = await catalog.listEnvironments(db, p.folder);
			return `${header}## Environments\n${catalog.renderRows(e.environments, "None.")}\n\n## Variables\n${catalog.renderRows(e.variables, "None.")}\n\n## Project references\n${catalog.renderRows(e.references, "None.")}`;
		}
		case "executions":
			return header + catalog.renderExecutions(await catalog.listExecutions(db, p));
		case "messages":
			need(p, p.view, "executionId");
			return header + catalog.renderMessages(await catalog.executionMessages(db, p.executionId!, p.level ?? "errors", p.limit ?? 50));
		case "diagnose":
			need(p, p.view, "executionId");
			return header + catalog.renderDiagnosis(await catalog.diagnose(db, p.executionId!), p.executionId!);
		default:
			throw new ToolError(`Unknown view "${String(p.view)}". Use folders, projects, packages, parameters, environments, executions, messages or diagnose.`);
	}
}

export interface ExecuteParams extends catalog.StartOptions {
	wait?: boolean;
	timeoutSeconds?: number;
	profile?: string;
}

export async function catalogExecute(env: ToolEnv, p: ExecuteParams): Promise<string> {
	const { db, profile } = await env.database(p.profile);
	const settings = [
		p.environment ? `environment ${p.environment}` : "no environment",
		...(p.parameters ?? []).map((x) => `${x.name}=${x.value}`),
		p.use32Bit ? "32-bit" : "",
	].filter(Boolean);
	await env.confirm("Start SSIS execution?", `${p.folder}/${p.project}/${p.package}\non ${describeProfile(profile)}\n${settings.join(", ")}`);

	const id = await catalog.startExecution(db, p);
	if (p.wait === false) return `Started execution #${id} on ${profile.server}. Check it with ssisdb_query view "diagnose" executionId ${id}.`;

	env.progress?.(`Execution #${id} started; waiting…`);
	const { status, finished } = await catalog.waitForExecution(db, id, {
		timeoutSeconds: p.timeoutSeconds ?? 120,
		signal: env.signal,
		onPoll: (s) => env.progress?.(`Execution #${id}: ${s}`),
	});
	if (!finished) {
		return `Execution #${id} is still ${status} after ${p.timeoutSeconds ?? 120}s. It keeps running on the server; check later with ssisdb_query view "diagnose" executionId ${id}, or stop it with ssisdb_stop.`;
	}
	if (status === "succeeded") return `Execution #${id} succeeded.`;
	return `Execution #${id} ended with status: ${status}.\n\n${catalog.renderDiagnosis(await catalog.diagnose(db, id), id)}`;
}

export async function catalogStop(env: ToolEnv, p: { executionId: number; profile?: string }): Promise<string> {
	const { db, profile } = await env.database(p.profile);
	const row = await catalog.executionStatus(db, p.executionId);
	if (!row) throw new ToolError(`No execution #${p.executionId} in the catalog.`);
	const status = catalog.STATUS[Number(row.status)] ?? String(row.status);
	if (!["created", "running", "pending"].includes(status)) return `Execution #${p.executionId} is already ${status}; nothing to stop.`;
	await env.confirm("Stop SSIS execution?", `#${p.executionId} (${status}) on ${describeProfile(profile)}`);
	await catalog.stopExecution(db, p.executionId);
	return `Stop requested for execution #${p.executionId}. It may take a moment to reach "canceled".`;
}

export async function catalogDeploy(env: ToolEnv, p: { ispac: string; folder: string; project?: string; createFolder?: boolean; profile?: string }): Promise<string> {
	const ispacPath = resolvePath(env.cwd, p.ispac);
	if (!existsSync(ispacPath) || !/\.ispac$/i.test(ispacPath)) throw new ToolError(`Not an .ispac file: ${p.ispac}. Build the project in Visual Studio (or with SSISBuild) to produce one.`);
	const { db, profile } = await env.database(p.profile);
	const embedded = loadProject(ispacPath);
	await env.confirm(
		"Deploy SSIS project?",
		`${relative(env.cwd, ispacPath) || ispacPath} (${embedded.packages.length} packages)\nto ${p.folder}/${p.project ?? embedded.name ?? "?"} on ${describeProfile(profile)}\nThis replaces the deployed project if it exists.${p.createFolder ? "\nThe folder is created if missing." : ""}`,
	);
	const result = await catalog.deployProject(db, { ispacPath, folder: p.folder, project: p.project, createFolder: p.createFolder });
	if (result.status === "succeeded") return `Deployed ${p.folder}/${result.project} (operation #${result.operationId}).`;
	return `Deployment operation #${result.operationId} ended with status: ${result.status}.\n${catalog.renderMessages(result.messages)}`;
}

export interface SetParameterParams {
	folder: string;
	project?: string;
	package?: string;
	environment?: string;
	name: string;
	value?: string;
	referencedVariable?: string;
	profile?: string;
}

export async function catalogSetParameter(env: ToolEnv, p: SetParameterParams): Promise<string> {
	const { db, profile } = await env.database(p.profile);
	if (p.environment) {
		if (p.value === undefined) throw new ToolError("Setting an environment variable needs value.");
		await env.confirm("Change SSIS environment variable?", `${p.folder}/${p.environment}: ${p.name} = ${p.value}\non ${describeProfile(profile)}`);
		const { dataType } = await catalog.setEnvironmentVariable(db, { folder: p.folder, environment: p.environment, name: p.name, value: p.value });
		return `Set environment variable ${p.folder}/${p.environment}/${p.name} (${dataType}). Executions that reference this environment use it from their next start.`;
	}
	if (!p.project) throw new ToolError("Pass project (and optionally package) for a parameter, or environment for an environment variable.");
	const target = `${p.folder}/${p.project}${p.package ? `/${p.package}` : ""}`;
	const shown = p.referencedVariable ? `→ environment variable ${p.referencedVariable}` : `= ${p.value}`;
	await env.confirm("Change SSIS parameter default?", `${target}: ${p.name} ${shown}\non ${describeProfile(profile)}`);
	const { scope, dataType } = await catalog.setParameter(db, { folder: p.folder, project: p.project, package: p.package, name: p.name, value: p.value, referencedVariable: p.referencedVariable });
	return `Set ${scope} parameter ${target}: ${p.name} (${dataType}) ${shown}. This is the server-side default for future executions.`;
}
