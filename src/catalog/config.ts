import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Profile {
	name: string;
	server: string;
	port?: number;
	/** Catalog database; SSISDB unless the instance was set up differently. */
	database: string;
	/** sql: SQL login. ntlm: Windows account (needed for catalog writes on-prem). entra: Microsoft Entra default credential chain. */
	auth: "sql" | "ntlm" | "entra";
	user?: string;
	domain?: string;
	/** Name of the environment variable holding the password. Passwords are never read from the file. */
	passwordEnv?: string;
	encrypt: boolean;
	trustServerCertificate: boolean;
	/** Where the profile was defined, for error messages. */
	source: string;
}

export interface CatalogConfig {
	profiles: Profile[];
	defaultProfile?: string;
}

export class ConfigError extends Error {}

export function configPaths(cwd: string): string[] {
	return [join(homedir(), ".pi", "agent", "ssis.json"), join(cwd, ".pi", "ssis.json")];
}

export const CONFIG_EXAMPLE = `{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "server": "sql-dev.example.com",
      "auth": "ntlm",
      "domain": "CORP",
      "user": "etl_operator",
      "passwordEnv": "SSIS_DEV_PASSWORD",
      "trustServerCertificate": true
    }
  }
}`;

function parseFile(path: string): CatalogConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	const file = raw as { defaultProfile?: string; profiles?: Record<string, Record<string, unknown>> };
	const profiles: Profile[] = [];
	for (const [name, p] of Object.entries(file.profiles ?? {})) {
		if ("password" in p) {
			throw new ConfigError(`${path}: profile "${name}" contains a password. Remove it and set "passwordEnv" to the name of an environment variable instead.`);
		}
		if (typeof p.server !== "string" || !p.server) throw new ConfigError(`${path}: profile "${name}" needs a "server".`);
		const auth = (p.auth ?? "sql") as Profile["auth"];
		if (!["sql", "ntlm", "entra"].includes(auth)) throw new ConfigError(`${path}: profile "${name}" has unknown auth "${String(p.auth)}" (use sql, ntlm or entra).`);
		if (auth !== "entra" && (typeof p.user !== "string" || typeof p.passwordEnv !== "string")) {
			throw new ConfigError(`${path}: profile "${name}" needs "user" and "passwordEnv" for ${auth} authentication.`);
		}
		profiles.push({
			name,
			server: p.server,
			port: typeof p.port === "number" ? p.port : undefined,
			database: typeof p.database === "string" ? p.database : "SSISDB",
			auth,
			user: p.user as string | undefined,
			domain: p.domain as string | undefined,
			passwordEnv: p.passwordEnv as string | undefined,
			encrypt: p.encrypt !== false,
			trustServerCertificate: p.trustServerCertificate === true,
			source: path,
		});
	}
	return { profiles, defaultProfile: file.defaultProfile };
}

/** Merges the user-level and project-level files; project profiles win on name clashes. */
export function loadConfig(cwd: string, paths = configPaths(cwd)): CatalogConfig {
	const merged = new Map<string, Profile>();
	let defaultProfile: string | undefined;
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const config = parseFile(path);
		for (const p of config.profiles) merged.set(p.name, p);
		defaultProfile = config.defaultProfile ?? defaultProfile;
	}
	return { profiles: [...merged.values()], defaultProfile };
}

export function pickProfile(config: CatalogConfig, requested: string | undefined, cwd: string): Profile {
	if (!config.profiles.length) {
		throw new ConfigError(`No SSISDB connection profiles are configured. Create ${configPaths(cwd)[1]} (or ${configPaths(cwd)[0]}) like this:\n${CONFIG_EXAMPLE}`);
	}
	const name = requested ?? config.defaultProfile ?? (config.profiles.length === 1 ? config.profiles[0]!.name : undefined);
	if (!name) {
		throw new ConfigError(`Several profiles are configured and none is the default. Pass profile, or run /ssis to choose. Available: ${config.profiles.map((p) => p.name).join(", ")}`);
	}
	const profile = config.profiles.find((p) => p.name === name);
	if (!profile) throw new ConfigError(`No profile "${name}". Available: ${config.profiles.map((p) => p.name).join(", ")}`);
	return profile;
}

export function describeProfile(p: Profile): string {
	const who = p.auth === "entra" ? "Entra ID" : `${p.domain ? `${p.domain}\\` : ""}${p.user} (${p.auth})`;
	return `${p.name}: ${p.server}${p.port ? `,${p.port}` : ""}/${p.database} as ${who}`;
}
