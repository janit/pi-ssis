# pi-ssis

SQL Server Integration Services (SSIS) tools for the [pi](https://pi.dev) coding agent. It lets pi read, edit, operate and migrate SSIS packages without Visual Studio or any Microsoft tooling installed, on Linux, macOS or Windows.

## Install

```bash
pi install git:github.com/janit/pi-ssis      # or: pi install /path/to/pi-ssis
pi -e /path/to/pi-ssis                       # try it for one session
```

Requires pi 1.0 or later. Dependencies are installed by `pi install`; for a local path, run `npm install` in the package first.

## What pi can do with it

| Ask pi to… | Tools used |
|---|---|
| Explain a project or package, document it, review it | `ssis_overview`, `ssis_package`, `ssis_dataflow` |
| Find where a table, column, variable or path is used | `ssis_search` |
| Change SQL, connection strings, expressions, variables, parameters; add an Execute SQL task; rewire precedence constraints; enable/disable tasks | `ssis_edit`, `ssis_validate` |
| Say why last night's run failed, list deployed projects and executions | `ssisdb_query` |
| Run or stop a package, deploy an `.ispac`, change parameter defaults or environment variables | `ssisdb_execute`, `ssisdb_stop`, `ssisdb_deploy`, `ssisdb_set_parameter` |
| Assess and convert packages to another stack | `ssis_migration_inventory` |

Three skills (`ssis-packages`, `ssis-catalog`, `ssis-migration`) tell pi how to use the tools well. Force one with `/skill:ssis-packages`.

Package tools accept a `.dtsx` path, or `Project.ispac!Package.dtsx` for a package inside a deployment file. Project tools accept a directory or an `.ispac`.

## Editing

`ssis_edit` applies a list of operations, validates the result and writes only if the package is still structurally sound. If any operation fails, nothing is written. Edits are spliced into the original text, so line endings, the byte order mark and every untouched line are preserved and diffs stay small.

Operations: `set_sql`, `set_property`, `set_connection_string`, `set_expression`, `set_disabled`, `add_variable`, `remove_variable`, `rename_variable`, `add_parameter`, `remove_parameter`, `rename_parameter`, `add_execute_sql_task`, `add_constraint`, `remove_constraint`.

## Connecting to SSISDB

Create `.pi/ssis.json` in the project (or `~/.pi/agent/ssis.json` for all projects; project profiles win):

```json
{
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
}
```

| Field | Meaning |
|---|---|
| `server`, `port` | SQL Server host and optional port |
| `database` | Catalog database, default `SSISDB` |
| `auth` | `sql` (SQL login), `ntlm` (Windows account) or `entra` (Microsoft Entra default credentials) |
| `user`, `domain` | Account; `domain` for `ntlm` |
| `passwordEnv` | Name of the environment variable holding the password |
| `encrypt`, `trustServerCertificate` | TLS options; `encrypt` defaults to true |

Passwords are never read from the file; a profile containing a `password` field is rejected. `/ssis` shows or switches the active profile, and `/ssis test` checks the connection.

**On-premises SSISDB refuses to start executions or deploy projects for SQL logins.** Use an `ntlm` profile for those. Reading works with any login.

## Safety

- Reading never asks for confirmation and never returns sensitive parameter or variable values.
- Every tool that changes the server (execute, stop, deploy, set parameter) asks you to confirm, showing the server and the exact target.
- In print/JSON mode there is nobody to ask, so those tools refuse unless pi is started with `--ssis-allow-write`. Put the flag after the prompt (`pi -p "run the load" --ssis-allow-write`); placed directly before it, pi reads the prompt as the flag's value.
- Extensions run with your permissions. The catalog tools can do whatever the configured account can do; use a least-privilege account.

## Limits

- **Structural validation only.** `ssis_validate` and `ssis_edit` check ids, references and graph shape. They cannot run a package or validate it against live databases; confirm edits in Visual Studio or a test catalog.
- **No new data flow components.** Adding sources or transformations, or changing columns, needs the designer, which generates column and lineage metadata against a live database. Properties of existing components (queries, table names) can be changed.
- **Legacy packages are read-only.** SSIS 2005/2008 packages (format below 6) can be read, searched and inventoried, but not edited.
- **Encrypted content.** Packages saved with `EncryptAllWith…` cannot be read. Sensitive values in other protection levels are shown as `<sensitive>`.
- **Catalog tools are not verified against a real SSISDB.** SSISDB only exists on SQL Server for Windows. The tools are tested against a fake database and against a real SQL Server holding a stub of the catalog schema (`test/integration/`), which proves the SQL, parameter typing and driver behaviour but not the behaviour of the real catalog procedures. NTLM and Entra authentication are untested. Expect rough edges the first time you use them on a real server.
- Execution times are shown in UTC.
- New tasks have no saved position in the designer layout; Visual Studio places them when the package is next opened.

## Development

```bash
npm install
npm test          # vitest

# optional: also run the catalog code against a real SQL Server (stub schema)
docker run -d --rm -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='<password>' -p 127.0.0.1:14339:1433 mcr.microsoft.com/mssql/server:2022-latest
PI_SSIS_TEST_SERVER=127.0.0.1 PI_SSIS_TEST_PORT=14339 PI_SSIS_TEST_PASSWORD='<password>' npm test
npm run typecheck
```

`src/` has no dependency on pi: `dtsx/` parses, `render/` turns the model into compact text, `edit/` applies and validates changes, `catalog/` talks to SSISDB through a small `SqlExecutor` interface, `migration/` builds inventories, and `tools.ts` is what the extension in `extensions/ssis/index.ts` registers.

## License

MIT
