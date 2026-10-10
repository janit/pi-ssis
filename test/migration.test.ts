import { describe, expect, it } from "vitest";
import { parsePackage } from "../src/dtsx/parse.ts";
import { loadPackage, loadProject } from "../src/dtsx/project.ts";
import { buildInventory, renderInventory, renderProjectInventory } from "../src/migration/inventory.ts";
import { fixture, PROJECT } from "./helpers.ts";

describe("migration inventory", () => {
	const inv = buildInventory(loadPackage(`${PROJECT}/LoadSales.dtsx`).package);
	const item = (name: string) => inv.items.find((i) => i.name === name)!;

	it("classifies each task and explains why", () => {
		expect(inv.items.map((i) => `${i.name}:${i.complexity}`)).toEqual([
			"Truncate staging:low",
			"For each sales file:medium",
			"Load file:low",
			"Archive file:high",
			"Run merge package:low",
			"Notify failure:low",
			"OnError:medium",
			"Log error:low",
		]);
		expect(inv.totals).toEqual({ low: 5, medium: 2, high: 1 });
		expect(item("Truncate staging").notes.join(" ")).toMatch(/stored in User::RowCount/);
		expect(item("For each sales file").summary).toBe("loops over files matching sales_*.csv");
		expect(item("Load file").summary).toBe("Read file [FlatFileSource] → Add audit columns [DerivedColumn] → Write staging [OLEDBDestination]");
		expect(item("Notify failure").notes.join(" ")).toMatch(/Disabled in the package/);
		expect(item("Run merge package").notes).toEqual(["Passes RowsLoaded ← User::RowCount."]);
	});

	it("lists what cannot be converted mechanically", () => {
		expect(inv.blockers).toEqual(["Package\\For each sales file\\Archive file — script task (6 lines of CSharp) must be reimplemented by hand"]);
		expect(inv.childPackages).toEqual(["MergeSales.dtsx"]);
		expect(inv.considerations.join("\n")).toMatch(/Package parameters to carry over as job\/run arguments: ImportFolder/);
		expect(inv.considerations.join("\n")).toMatch(/1 variable\(s\) are computed with the SSIS expression language/);
	});

	it("flags environment-bound connections", () => {
		const notes = Object.fromEntries(inv.connections.map((c) => [c.name, c.notes.join(" ")]));
		expect(notes.Staging).toMatch(/Windows integrated authentication/);
		expect(notes.SalesFile).toMatch(/Windows drive or UNC path/);
		expect(notes.SalesFile).toMatch(/Built at run time from expressions on ConnectionString/);
	});

	it("raises complexity for transactions, legacy formats and unknown components", () => {
		const merge = buildInventory(loadPackage(`${PROJECT}/MergeSales.dtsx`).package);
		expect(merge.items[0]).toMatchObject({ complexity: "medium" });
		expect(merge.items[0]!.notes.join(" ")).toMatch(/MSDTC/);

		const legacy = buildInventory(parsePackage(fixture("Legacy2008.dtsx")));
		expect(legacy.considerations.join("\n")).toMatch(/1 legacy package configuration\(s\) \(ConfigFile\)/);
		expect(legacy.considerations.join("\n")).toMatch(/Legacy package format 3/);

		const custom = fixture("project/LoadSales.dtsx").replace(`componentClassID="Microsoft.DerivedColumn"`, `componentClassID="Acme.SuperTransform"`);
		const withCustom = buildInventory(parsePackage(custom));
		expect(withCustom.items.find((i) => i.name === "Load file")!.complexity).toBe("high");
		expect(withCustom.blockers.join("\n")).toMatch(/Add audit columns — Not a built-in component/);
	});

	it("renders package and project reports", () => {
		const text = renderInventory(inv);
		expect(text).toContain("8 tasks — 5 low, 2 medium, 1 high complexity");
		expect(text).toContain("## Needs manual work");
		expect(text).toContain("- [high] Package\\For each sales file\\Archive file (Script): custom CSharp script, 6 lines");

		const project = renderProjectInventory(loadProject(PROJECT));
		expect(project).toContain("2 packages, 9 tasks — 5 low, 3 medium, 1 high complexity");
		expect(project.indexOf("- MergeSales.dtsx")).toBeLessThan(project.indexOf("- LoadSales.dtsx"));
		expect(project).toContain("Project parameters to carry over: Environment, ApiKey");
	});
});
