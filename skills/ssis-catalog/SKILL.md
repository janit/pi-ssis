---
name: ssis-catalog
description: Operate and troubleshoot the SSIS catalog (SSISDB) on a SQL Server - list deployed projects, find out why an SSIS execution or SQL Agent ETL job failed, start or stop package executions, deploy an .ispac, and change parameter defaults or environment variables. Use when the user mentions SSISDB, the Integration Services catalog, a failed package run, or deploying SSIS projects.
---

# Operating the SSIS catalog

Use the `ssisdb_*` tools. They need a connection profile; if a tool reports that none is configured, show the user the example it prints and stop. Do not ask for a password in chat: profiles name an environment variable that holds it. `/ssis` shows or switches the active profile and `/ssis test` checks the connection.

## Why did it fail?

1. `ssisdb_query` view `executions` with `status: "failed"` (add `sinceHours`, `project` or `package` to narrow) to find the run.
2. `ssisdb_query` view `diagnose` with that `executionId`. It returns the failed tasks, the error messages (deduplicated) and the parameter values used.
3. Read the first error, not the last. SSIS logs the root cause first and then a chain of consequences ("Task failed", "Package failed").
4. If you have the project source, open the failing task with `ssis_package` / `ssis_dataflow` to connect the error to the SQL or component involved.
5. Use view `messages` with `level: "warnings"` or `"all"` when the errors alone do not explain it.

Common causes worth naming when you see them:

- Login failed / cannot acquire connection: wrong environment or parameter values, or the run-as account lacks access. Compare the parameter values in the diagnosis with what the user expects.
- "Cannot insert NULL", truncation, conversion failed: a data problem in the source; the message names the column.
- VS_NEEDSNEWMETADATA: a source or destination table changed shape; the data flow must be refreshed in Visual Studio.
- "requested OLE DB provider ... is not registered", Excel/ACE errors: provider missing on the server, or 32-bit vs 64-bit runtime mismatch (`use32Bit`).
- No error messages at all with a failed or unexpectedly ended run: logging level was None, or the process was killed. Say so; do not invent a cause.

## Changing the server

`ssisdb_execute`, `ssisdb_stop`, `ssisdb_deploy` and `ssisdb_set_parameter` change a live server. Each asks the user to confirm. If the user declines, stop; do not retry or look for another route.

- State exactly what you are about to do (server, folder/project/package, environment, parameter values) before calling the tool.
- Prefer the lowest-impact action: diagnose before re-running, and re-run in a test environment before production.
- `ssisdb_execute` waits up to `timeoutSeconds` (default 120). For long packages pass `wait: false` and check later with view `diagnose`.
- Parameter overrides in `ssisdb_execute` apply to that run only. `ssisdb_set_parameter` changes the stored default for all future runs.
- An environment must already be referenced by the project before it can be used for an execution. Check with view `environments`.
- Deploying replaces the project in that folder. Confirm the target folder with view `projects` first.

Authentication limits you will hit:

- On-premises SSISDB refuses to start executions or deploy projects for SQL Server logins. Those need a profile with `"auth": "ntlm"` (a Windows account). Reading works with any login. If you see that refusal, explain it; do not suggest workarounds that bypass it.
- Sensitive parameter and variable values are never returned.

These tools were built without access to a live SSISDB. If a query fails with an unexpected SQL error, report the exact message to the user rather than guessing.
