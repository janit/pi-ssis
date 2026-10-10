# pi-ssis design

Date: 2026-10-11. Status: approved in conversation and implemented.

## Goal

A pi package that lets the pi coding agent work with SQL Server Integration Services without Microsoft tooling: explain packages, edit them safely, operate the SSISDB catalog, and plan migrations away from SSIS.

Success means that in a folder of `.dtsx` files pi can explain a package accurately, make a targeted edit that still opens in Visual Studio, say why an execution failed, and produce a migration inventory.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Runtime | Pure TypeScript, loaded by pi through jiti | Must run on Linux; `dtexec`/`dtutil`/SMO are Windows-only |
| Scope | All four capabilities in one package, built in order: read, edit, catalog, migration | Requested; each later phase builds on the parser |
| XML handling | Own offset-preserving reader; edits are text splices | A DOM round trip reformats the designer's one-attribute-per-line layout and ruins diffs |
| Migration | Target-agnostic inventory plus a skill | The right target depends on the user's repository |
| Server writes | Confirm every write in the UI; refuse without a UI unless `--ssis-allow-write` | Executions and deployments affect live systems |
| Credentials | Named profiles in `.pi/ssis.json`; passwords only from environment variables | Keep secrets out of files the agent reads |
| Test assets | Hand-written fixtures in the repo; public sample packages used for robustness during development, not committed | No user packages or server were available |

## Structure

`src/` does not import pi.

- `dtsx/xml.ts` — XML reader recording source offsets for every element and attribute.
- `dtsx/parse.ts`, `pipeline.ts`, `project.ts` — `.dtsx` (formats 3 and 6–8), data flows, `.conmgr`, `Project.params`, `.dtproj`, `.ispac` into the model in `model.ts`.
- `dtsx/facts.ts` — flattens a package into searchable text with locations.
- `render/` — model to compact text for the model's context.
- `edit/splice.ts`, `ops.ts`, `validate.ts` — fourteen edit operations, applied in order, validated, and rejected if they introduce a structural error.
- `catalog/` — connection profiles, a `SqlExecutor` interface with an `mssql` implementation, catalog queries and procedures.
- `migration/inventory.ts` — per-task and per-component classification.
- `guard.ts` — the write confirmation rule.
- `tools.ts` — tool implementations; `extensions/ssis/index.ts` registers them with pi.
- `skills/` — `ssis-packages`, `ssis-catalog`, `ssis-migration`.

## Known limits

- Validation is structural. Nothing here runs a package or checks metadata against a database.
- Data flow components cannot be added or have their columns changed.
- Format 3 (SSIS 2005/2008) packages are read-only; fully encrypted packages are unreadable.
- Catalog behaviour is verified against a stub of the catalog schema on SQL Server for Linux, not a real SSISDB. NTLM and Entra authentication are untested.
- On-premises SSISDB rejects SQL logins for `create_execution` and `deploy_project`; those need Windows authentication.

## Deviation from the superpowers process

The user approved the design and asked for autonomous implementation, so the written-spec review and the separate implementation-plan document were skipped; this file records the design as built.
