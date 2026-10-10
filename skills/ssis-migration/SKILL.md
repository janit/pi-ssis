---
name: ssis-migration
description: Plan and carry out migration of SQL Server Integration Services (SSIS) packages to another stack such as plain SQL and stored procedures, Python, dbt, Azure Data Factory, Airflow or Spark. Use when the user wants to move off SSIS, estimate migration effort, or convert a specific package or data flow.
---

# Migrating away from SSIS

Work from the package's behaviour, not its XML. The goal is a readable implementation in the target stack that produces the same data, not a task-for-task copy.

## 1. Assess

- `ssis_migration_inventory` on the project directory: packages in suggested order (called packages before their callers), task counts by complexity, and everything that needs manual work.
- `ssis_migration_inventory` on each package: per-task summary and notes.
- Present this to the user before writing any code. Call out the manual items explicitly; they drive the estimate.

Complexity ratings are a guide to conversion difficulty, not hours. Do not turn them into time estimates unless the user asks, and say they are rough if you do.

## 2. Agree the target

If the user has not said, look at the repository for an existing stack (dbt project, Airflow DAGs, Python package, SQL migrations) and propose following it. Ask only if nothing indicates a direction. Settle these before converting:

- Where orchestration lives (scheduler, job runner).
- How connections and secrets are supplied. SSIS connection strings with integrated security do not carry over.
- Whether file paths (drive letters, UNC shares) are reachable from the new runtime.

## 3. Convert one package at a time

For each package, read it with `ssis_package` (use `detail: "full"`) and each data flow with `ssis_dataflow`, then translate:

| SSIS | Usual equivalent |
|---|---|
| Execute SQL task | The same SQL, run by the orchestrator. Turn `?` markers into named parameters. |
| Data flow: source → transforms → destination in one database | A single `INSERT ... SELECT` / `MERGE`. Derived Column becomes expressions, Conditional Split becomes `WHERE`, Lookup becomes a `JOIN`, Aggregate becomes `GROUP BY`, Union All becomes `UNION ALL`. Sorts that only feed a Merge Join disappear. |
| Data flow across servers or from files | Extract-load step in the target tool, then SQL transforms. |
| Lookup with "ignore failure" or redirect | `LEFT JOIN`; route unmatched rows explicitly. Check the no-match setting before choosing. |
| OLE DB Command (row by row) | Set-based `UPDATE` / `DELETE` / `MERGE`. |
| Slowly Changing Dimension | `MERGE` for type 1 columns; expire-and-insert for type 2. |
| Foreach over files | Directory listing in the orchestrator, one run per file. |
| Foreach over a result set | Usually one set-based statement; keep a loop only if each iteration has side effects. |
| Precedence constraints | Task dependencies. Failure and Completion constraints become failure hooks / `finally`. |
| Variables and expressions | Orchestrator parameters and ordinary code. |
| Package parameters, environments | Job arguments and environment configuration. |
| Event handlers (OnError) | Failure callbacks or try/catch with logging. |
| Execute Package task | Call the converted child job; pass the same arguments. |
| Script task / Script component | Read the code and rewrite it by hand. There is no mechanical translation. |

Translate SSIS expressions carefully: `(DT_WSTR, n) x` is a cast, `x ? a : b` is conditional, `==` is equality, string literals use double quotes, and `ISNULL(x)` is a boolean test, not a coalesce. Type names differ too: `DT_WSTR` nvarchar, `DT_STR` varchar, `DT_I4` int, `DT_I8` bigint, `DT_NUMERIC(p,s)` numeric, `DT_DBTIMESTAMP` datetime, `DT_BOOL` bit.

Preserve behaviour that is easy to lose:

- Disabled tasks: ask whether they should be dropped rather than silently omitting or converting them.
- `TransactionOption=Required`: the tasks ran in one distributed transaction. Decide how atomicity is kept.
- Error-row redirection in data flows: rejected rows went somewhere. Reproduce it or get agreement to drop it.
- Destination options such as table lock, keep identity, keep nulls and commit size.
- Implicit truncation and code-page conversions between column types.

## 4. Verify

Never claim a conversion is equivalent without evidence. Propose a check the user can run: row counts and checksums per target table between the SSIS output and the new output for the same input, plus a comparison of rejected rows. If you could not run anything, say the conversion is untested.

Things this tooling cannot see: the contents of encrypted packages, sensitive values, third-party component internals, and what SQL Agent job steps or SSISDB environments supply at run time. Use `ssisdb_query` (views `parameters`, `environments`) for the last one if a catalog profile is configured.
