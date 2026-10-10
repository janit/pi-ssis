import { type Package, walk } from "./model.ts";

/** One searchable piece of text in a package and where it lives. */
export interface Fact {
	where: string;
	field: string;
	text: string;
}

/** Flattens everything a reader might search for: SQL, expressions, names, settings. */
export function collectFacts(pkg: Package): Fact[] {
	const facts: Fact[] = [];
	const add = (where: string, field: string, text: string | undefined) => {
		if (text !== undefined && text !== "") facts.push({ where, field, text });
	};
	const addRecord = (where: string, prefix: string, record: Record<string, string>) => {
		for (const [k, v] of Object.entries(record)) add(where, `${prefix}${k}`, v);
	};

	for (const c of pkg.connections) {
		const where = `Connection ${c.name}`;
		add(where, "name", c.name);
		add(where, "connectionString", c.connectionString);
		addRecord(where, "expression ", c.expressions);
		addRecord(where, "", c.properties);
	}
	for (const p of pkg.parameters) {
		add(`Parameter $Package::${p.name}`, "name", p.name);
		add(`Parameter $Package::${p.name}`, "value", p.value);
	}

	walk(pkg.root, (e) => {
		const where = e.refId;
		add(where, "name", e.name);
		add(where, "description", e.description);
		addRecord(where, "expression ", e.expressions);
		for (const v of e.variables) {
			const vw = `Variable ${v.namespace}::${v.name} (${e.refId})`;
			add(vw, "name", `${v.namespace}::${v.name}`);
			add(vw, "value", v.value);
			add(vw, "expression", v.expression);
		}
		for (const c of e.constraints) add(where, `constraint ${c.from} -> ${c.to}`, c.expression);
		if (e.sql) {
			add(where, "sql", e.sql.statement);
			add(where, "connection", e.sql.connection);
			for (const b of e.sql.parameterBindings) add(where, `parameter ${b.name}`, b.variable);
			for (const b of e.sql.resultBindings) add(where, `result ${b.name}`, b.variable);
		}
		if (e.executePackage) {
			add(where, "childPackage", e.executePackage.packageName);
			for (const a of e.executePackage.parameterAssignments) add(where, `childParameter ${a.parameter}`, a.source);
		}
		if (e.script) {
			add(where, "scriptVariables", [...e.script.readOnlyVariables, ...e.script.readWriteVariables].join(", "));
			for (const f of e.script.files) add(where, `script ${f.name}`, f.code);
		}
		add(where, "expressionTask", e.expression);
		if (e.forLoop) {
			add(where, "forLoop init", e.forLoop.init);
			add(where, "forLoop eval", e.forLoop.eval);
			add(where, "forLoop assign", e.forLoop.assign);
		}
		if (e.forEach) {
			addRecord(where, "forEach ", e.forEach.properties);
			for (const m of e.forEach.variableMappings) add(where, `forEach mapping ${m.index}`, m.variable);
		}
		if (e.taskProperties) addRecord(where, "", e.taskProperties);
		for (const c of e.dataFlow?.components ?? []) {
			const cw = `${e.refId} :: ${c.name}`;
			add(cw, "name", c.name);
			addRecord(cw, "", c.properties);
			for (const conn of c.connections) add(cw, "connection", conn.manager ?? conn.ref);
			for (const f of c.script?.files ?? []) add(cw, `script ${f.name}`, f.code);
			for (const port of [...c.inputs, ...c.outputs]) {
				addRecord(cw, `${port.name} `, port.properties);
				for (const col of port.columns) {
					add(cw, `column (${port.name})`, col.name);
					addRecord(cw, `column ${col.name} `, col.properties);
				}
			}
		}
	});
	return facts;
}

export interface SearchHit extends Fact {
	/** The matching line, trimmed, with a little surrounding text. */
	excerpt: string;
}

export function searchFacts(facts: Fact[], query: string, options: { regex?: boolean } = {}): SearchHit[] {
	const pattern = options.regex ? new RegExp(query, "i") : undefined;
	const needle = query.toLowerCase();
	const hits: SearchHit[] = [];
	for (const fact of facts) {
		const index = pattern ? fact.text.search(pattern) : fact.text.toLowerCase().indexOf(needle);
		if (index === -1) continue;
		const start = Math.max(0, index - 60);
		const end = Math.min(fact.text.length, index + Math.max(needle.length, 20) + 100);
		const excerpt = `${start > 0 ? "…" : ""}${fact.text.slice(start, end).replace(/\s+/g, " ")}${end < fact.text.length ? "…" : ""}`;
		hits.push({ ...fact, excerpt });
	}
	return hits;
}
