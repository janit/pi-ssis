import { describe, expect, it } from "vitest";
import { attr, child, escapeAttr, parseXml, text, XmlError } from "../src/dtsx/xml.ts";

describe("parseXml", () => {
	it("decodes entities and records value offsets", () => {
		const source = `<?xml version="1.0"?>\n<a:root xmlns:a="urn:x" a:sql="x &lt; 1&#xA;y">\n  <b>t &amp; u</b><c><![CDATA[<raw>]]></c><d />\n</a:root>`;
		const { root } = parseXml(source);
		expect(root.local).toBe("root");
		expect(attr(root, "sql")).toBe("x < 1\ny");
		expect(text(child(root, "b")!)).toBe("t & u");
		expect(text(child(root, "c")!)).toBe("<raw>");
		expect(child(root, "d")!.selfClosing).toBe(true);
		const sql = root.attrs.find((a) => a.local === "sql")!;
		expect(source.slice(sql.valueStart, sql.valueEnd)).toBe("x &lt; 1&#xA;y");
		expect(source.slice(root.start, root.end)).toMatch(/^<a:root[\s\S]*<\/a:root>$/);
	});

	it("ignores a byte order mark, comments and processing instructions", () => {
		const { root } = parseXml(`\uFEFF<?xml version="1.0"?><!-- c --><r><?pi x?><k/></r>`);
		expect(root.children).toHaveLength(1);
	});

	it("reports mismatched tags with a line number", () => {
		expect(() => parseXml("<a>\n<b></a>")).toThrow(XmlError);
		expect(() => parseXml("<a>\n<b></a>")).toThrow(/line 2/);
	});

	it("escapes attribute values the way the designer does", () => {
		expect(escapeAttr(`a < "b" &\r\n\tc`)).toBe("a &lt; &quot;b&quot; &amp;&#xD;&#xA;&#x9;c");
	});
});
