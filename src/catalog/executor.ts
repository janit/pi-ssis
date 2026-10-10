import type { Profile } from "./config.ts";
import { ConfigError } from "./config.ts";

export type SqlValue = string | number | boolean | Date | Buffer | null;
export type Row = Record<string, unknown>;

/** The only thing the catalog code needs from a database connection. */
export interface SqlExecutor {
	query(sql: string, params?: Record<string, SqlValue>): Promise<Row[]>;
	close(): Promise<void>;
}

/** Connects with the `mssql` driver. Loaded lazily so offline tools never pay for it. */
export async function connect(profile: Profile, env: NodeJS.ProcessEnv = process.env): Promise<SqlExecutor> {
	let password: string | undefined;
	if (profile.auth !== "entra") {
		password = env[profile.passwordEnv!];
		if (!password) {
			throw new ConfigError(`Profile "${profile.name}" reads its password from the environment variable ${profile.passwordEnv}, which is not set. Export it before starting pi.`);
		}
	}
	const mssql = (await import("mssql")).default;
	const config: Record<string, unknown> = {
		server: profile.server,
		port: profile.port,
		database: profile.database,
		options: { encrypt: profile.encrypt, trustServerCertificate: profile.trustServerCertificate },
		connectionTimeout: 15_000,
		requestTimeout: 120_000,
		pool: { max: 2, min: 0 },
	};
	if (profile.auth === "entra") {
		config.authentication = { type: "azure-active-directory-default", options: {} };
	} else {
		config.user = profile.user;
		config.password = password;
		// The driver switches to NTLM when a domain is supplied.
		if (profile.auth === "ntlm") config.domain = profile.domain ?? "";
	}
	const pool = await new mssql.ConnectionPool(config as never).connect();
	return {
		async query(sql, params = {}) {
			const request = pool.request();
			for (const [name, value] of Object.entries(params)) {
				if (Buffer.isBuffer(value)) request.input(name, mssql.VarBinary(mssql.MAX), value);
				else if (value === null) request.input(name, mssql.NVarChar, null);
				else request.input(name, value);
			}
			const result = await request.query(sql);
			return (result.recordset ?? []) as Row[];
		},
		async close() {
			await pool.close();
		},
	};
}
