import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { unzipSync } from "fflate";
import type { Connection, Package, Parameter } from "./model.ts";
import { parseConnection, parsePackage, truthy } from "./parse.ts";
import { attr, child, childElements, descendants, parseXml, text, type XElement } from "./xml.ts";

export interface ProjectPackage {
	/** Path relative to the project root, or the entry name inside an .ispac. */
	file: string;
	package?: Package;
	error?: string;
}

export interface Project {
	root: string;
	kind: "directory" | "ispac";
	name?: string;
	protectionLevel?: string;
	packages: ProjectPackage[];
	connections: Connection[];
	parameters: Parameter[];
}

const SKIP_DIRS = new Set(["obj", "bin", "node_modules", ".git", ".vs"]);
const RELEVANT = /\.(dtsx|conmgr|params|dtproj|manifest)$/i;

function stripBom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

export function readText(path: string): string {
	const buffer = readFileSync(path);
	// Older designers save UTF-16; everything current is UTF-8 with a BOM.
	if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
	return buffer.toString("utf8");
}

function collectDirectory(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const visit = (dir: string, depth: number) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < 4 && !SKIP_DIRS.has(entry.name)) visit(full, depth + 1);
			} else if (RELEVANT.test(entry.name)) {
				files.set(relative(root, full), readText(full));
			}
		}
	};
	visit(root, 0);
	return files;
}

function collectIspac(path: string): Map<string, string> {
	const files = new Map<string, string>();
	const entries = unzipSync(new Uint8Array(readFileSync(path)), { filter: (f) => RELEVANT.test(f.name) });
	for (const [name, bytes] of Object.entries(entries)) {
		let decoded = name;
		try {
			decoded = decodeURIComponent(name);
		} catch {
			// keep the raw entry name
		}
		files.set(decoded, Buffer.from(bytes).toString("utf8"));
	}
	return files;
}

/** Project.params stores System.TypeCode values, unlike packages, which store VARENUM codes. */
const TYPE_CODES: Record<string, string> = {
	"3": "Boolean",
	"5": "SByte",
	"6": "Byte",
	"7": "Int16",
	"8": "UInt16",
	"9": "Int32",
	"10": "UInt32",
	"11": "Int64",
	"12": "UInt64",
	"13": "Single",
	"14": "Double",
	"15": "Decimal",
	"16": "DateTime",
	"18": "String",
};

function ssisProperties(el: XElement): Record<string, string> {
	const out: Record<string, string> = {};
	const props = child(el, "Properties");
	for (const p of props ? childElements(props, "Property") : []) {
		const name = attr(p, "Name");
		if (name) out[name] = text(p).trim();
	}
	return out;
}

export function parseProjectParams(source: string): Parameter[] {
	const { root } = parseXml(stripBom(source));
	return childElements(root, "Parameter").map((p) => {
		const props = ssisProperties(p);
		const sensitive = truthy(props.Sensitive);
		return {
			name: attr(p, "Name") ?? "",
			dataType: TYPE_CODES[props.DataType ?? ""] ?? props.DataType ?? "String",
			value: sensitive ? "<sensitive>" : props.Value,
			required: truthy(props.Required),
			sensitive,
			description: props.Description || undefined,
			scope: "project" as const,
		};
	});
}

function parseManifest(source: string): { name?: string; protectionLevel?: string } {
	const { root } = parseXml(stripBom(source));
	let project: XElement | undefined = root.prefix === "SSIS" && root.local === "Project" ? root : undefined;
	if (!project) {
		descendants(root, (d) => {
			if (!project && d.prefix === "SSIS" && d.local === "Project") project = d;
		});
	}
	if (!project) return {};
	return { name: ssisProperties(project).Name, protectionLevel: attr(project, "ProtectionLevel") };
}

function buildProject(root: string, kind: Project["kind"], files: Map<string, string>): Project {
	const project: Project = { root, kind, packages: [], connections: [], parameters: [] };
	for (const [file, content] of files) {
		try {
			if (/\.conmgr$/i.test(file)) project.connections.push(parseConnection(parseXml(stripBom(content)).root, "project"));
			else if (/\.params$/i.test(file)) project.parameters.push(...parseProjectParams(content));
			else if (/\.(dtproj|manifest)$/i.test(file) && !project.name) Object.assign(project, parseManifest(content));
		} catch {
			// A broken auxiliary file must not hide the packages.
		}
	}
	for (const [file, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
		if (!/\.dtsx$/i.test(file)) continue;
		try {
			project.packages.push({
				file,
				package: parsePackage(stripBom(content), { projectConnections: project.connections, fileName: basename(file) }),
			});
		} catch (error) {
			project.packages.push({ file, error: (error as Error).message });
		}
	}
	return project;
}

/** Loads every package under a directory, or inside an .ispac deployment file. */
export function loadProject(path: string): Project {
	const full = resolve(path);
	if (!existsSync(full)) throw new Error(`Path not found: ${path}`);
	if (statSync(full).isDirectory()) return buildProject(full, "directory", collectDirectory(full));
	if (/\.ispac$/i.test(full)) return buildProject(full, "ispac", collectIspac(full));
	throw new Error(`Expected a directory or an .ispac file: ${path}`);
}

export interface LoadedPackage {
	package: Package;
	/** Exact file content, including any BOM; edits are spliced into this. */
	source: string;
	/** Path on disk, absent for packages inside an .ispac. */
	filePath?: string;
	label: string;
}

/**
 * Loads one package from `dir/Package.dtsx` or `Project.ispac!Package.dtsx`.
 * Project connection managers next to the package are resolved automatically.
 */
export function loadPackage(spec: string): LoadedPackage {
	const bang = spec.toLowerCase().indexOf(".ispac!");
	if (bang !== -1) {
		const archive = resolve(spec.slice(0, bang + 6));
		const entry = spec.slice(bang + 7);
		const files = collectIspac(archive);
		const content = files.get(entry) ?? [...files].find(([name]) => name.toLowerCase() === entry.toLowerCase())?.[1];
		if (content === undefined) {
			const available = [...files.keys()].filter((f) => /\.dtsx$/i.test(f)).join(", ");
			throw new Error(`No package "${entry}" in ${basename(archive)}. Available: ${available || "none"}`);
		}
		const project = buildProject(archive, "ispac", new Map([...files].filter(([f]) => !/\.dtsx$/i.test(f))));
		return {
			package: parsePackage(stripBom(content), { projectConnections: project.connections, fileName: entry }),
			source: content,
			label: spec,
		};
	}

	const filePath = resolve(spec);
	if (!existsSync(filePath)) throw new Error(`Package not found: ${spec}`);
	if (statSync(filePath).isDirectory() || /\.ispac$/i.test(filePath)) {
		throw new Error(`${spec} is a project, not a package. Use ssis_overview to list its packages.`);
	}
	const source = readText(filePath);
	const projectConnections: Connection[] = [];
	for (const entry of readdirSync(dirname(filePath))) {
		if (!/\.conmgr$/i.test(entry)) continue;
		try {
			projectConnections.push(parseConnection(parseXml(stripBom(readText(join(dirname(filePath), entry)))).root, "project"));
		} catch {
			// ignore unreadable connection managers
		}
	}
	return {
		package: parsePackage(stripBom(source), { projectConnections, fileName: basename(filePath) }),
		source,
		filePath,
		label: spec,
	};
}
