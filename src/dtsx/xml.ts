/**
 * Minimal XML reader that keeps source offsets for every node.
 *
 * SSIS files are written with one attribute per line and are diffed in source
 * control, so edits are applied as text splices against the original source
 * rather than by re-serialising a DOM. The offsets recorded here make that
 * possible; untouched regions stay byte-identical.
 */

export interface XAttr {
	name: string;
	local: string;
	value: string;
	/** Offset of the first character of the attribute name. */
	start: number;
	/** Offsets of the raw value, excluding the quotes. */
	valueStart: number;
	valueEnd: number;
}

export interface XText {
	type: "text" | "cdata";
	value: string;
	start: number;
	end: number;
	parent?: XElement;
}

export interface XElement {
	type: "element";
	name: string;
	prefix: string;
	local: string;
	attrs: XAttr[];
	children: XNode[];
	parent?: XElement;
	/** Offset of `<`. */
	start: number;
	/** Offset of the `>` or `/>` that closes the start tag. */
	startTagClose: number;
	/** Offset just after the start tag. */
	contentStart: number;
	/** Offset of `</` (equals contentStart for self-closing elements). */
	contentEnd: number;
	/** Offset just after the whole element. */
	end: number;
	selfClosing: boolean;
}

export type XNode = XElement | XText;

export interface XDocument {
	source: string;
	root: XElement;
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(raw: string): string {
	if (!raw.includes("&")) return raw;
	return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (all, body: string) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : all;
		}
		return ENTITIES[body] ?? all;
	});
}

/** Escapes an attribute value the way the SSIS designer writes it. */
export function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/\r/g, "&#xD;")
		.replace(/\n/g, "&#xA;")
		.replace(/\t/g, "&#x9;");
}

export function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const NAME_END = /[\s=/>]/;

export function parseXml(source: string): XDocument {
	let pos = 0;
	const len = source.length;
	let root: XElement | undefined;
	let current: XElement | undefined;

	const fail = (message: string): never => {
		const line = source.slice(0, pos).split("\n").length;
		throw new XmlError(`${message} (line ${line})`);
	};

	const addText = (type: "text" | "cdata", value: string, start: number, end: number) => {
		if (!current) return;
		current.children.push({ type, value, start, end, parent: current });
	};

	while (pos < len) {
		const lt = source.indexOf("<", pos);
		if (lt === -1) {
			if (current) fail(`Unclosed element <${current.name}>`);
			break;
		}
		if (lt > pos) addText("text", decodeEntities(source.slice(pos, lt)), pos, lt);
		pos = lt;

		if (source.startsWith("<!--", pos)) {
			const close = source.indexOf("-->", pos + 4);
			if (close === -1) fail("Unclosed comment");
			pos = close + 3;
			continue;
		}
		if (source.startsWith("<![CDATA[", pos)) {
			const close = source.indexOf("]]>", pos + 9);
			if (close === -1) fail("Unclosed CDATA section");
			addText("cdata", source.slice(pos + 9, close), pos, close + 3);
			pos = close + 3;
			continue;
		}
		if (source.startsWith("<?", pos)) {
			const close = source.indexOf("?>", pos + 2);
			if (close === -1) fail("Unclosed processing instruction");
			pos = close + 2;
			continue;
		}
		if (source.startsWith("<!", pos)) {
			const close = source.indexOf(">", pos + 2);
			if (close === -1) fail("Unclosed declaration");
			pos = close + 1;
			continue;
		}
		if (source[pos + 1] === "/") {
			const close = source.indexOf(">", pos + 2);
			if (close === -1) fail("Unclosed end tag");
			const name = source.slice(pos + 2, close).trim();
			if (!current) return fail(`Unexpected end tag </${name}>`);
			if (current.name !== name) fail(`Expected </${current.name}> but found </${name}>`);
			current.contentEnd = pos;
			current.end = close + 1;
			pos = close + 1;
			current = current.parent;
			continue;
		}

		// Start tag
		const start = pos;
		pos++;
		let nameEnd = pos;
		while (nameEnd < len && !NAME_END.test(source[nameEnd]!)) nameEnd++;
		const name = source.slice(pos, nameEnd);
		if (!name) fail("Malformed tag");
		const colon = name.indexOf(":");
		const element: XElement = {
			type: "element",
			name,
			prefix: colon === -1 ? "" : name.slice(0, colon),
			local: colon === -1 ? name : name.slice(colon + 1),
			attrs: [],
			children: [],
			parent: current,
			start,
			startTagClose: 0,
			contentStart: 0,
			contentEnd: 0,
			end: 0,
			selfClosing: false,
		};
		pos = nameEnd;

		for (;;) {
			while (pos < len && /\s/.test(source[pos]!)) pos++;
			if (pos >= len) fail(`Unclosed start tag <${name}>`);
			if (source[pos] === ">") {
				element.startTagClose = pos;
				pos++;
				break;
			}
			if (source[pos] === "/" && source[pos + 1] === ">") {
				element.startTagClose = pos;
				element.selfClosing = true;
				pos += 2;
				break;
			}
			const attrStart = pos;
			while (pos < len && !NAME_END.test(source[pos]!)) pos++;
			const attrName = source.slice(attrStart, pos);
			while (pos < len && /\s/.test(source[pos]!)) pos++;
			if (source[pos] !== "=") fail(`Attribute ${attrName} has no value`);
			pos++;
			while (pos < len && /\s/.test(source[pos]!)) pos++;
			const quote = source[pos];
			if (quote !== '"' && quote !== "'") fail(`Attribute ${attrName} is not quoted`);
			const valueStart = pos + 1;
			const valueEnd = source.indexOf(quote!, valueStart);
			if (valueEnd === -1) fail(`Unclosed value for attribute ${attrName}`);
			const attrColon = attrName.indexOf(":");
			element.attrs.push({
				name: attrName,
				local: attrColon === -1 ? attrName : attrName.slice(attrColon + 1),
				value: decodeEntities(source.slice(valueStart, valueEnd)),
				start: attrStart,
				valueStart,
				valueEnd,
			});
			pos = valueEnd + 1;
		}

		element.contentStart = pos;
		if (current) current.children.push(element);
		else if (!root) root = element;
		else fail("Multiple root elements");

		if (element.selfClosing) {
			element.contentEnd = pos;
			element.end = pos;
		} else {
			current = element;
		}
	}

	if (current) fail(`Unclosed element <${current.name}>`);
	if (!root) throw new XmlError("No root element found");
	return { source, root };
}

// ---- navigation helpers (namespace prefixes are ignored; SSIS uses them consistently) ----

export function isElement(node: XNode): node is XElement {
	return node.type === "element";
}

export function childElements(el: XElement, local?: string): XElement[] {
	const out: XElement[] = [];
	for (const child of el.children) {
		if (child.type === "element" && (local === undefined || child.local === local)) out.push(child);
	}
	return out;
}

export function child(el: XElement, local: string): XElement | undefined {
	for (const c of el.children) {
		if (c.type === "element" && c.local === local) return c;
	}
	return undefined;
}

export function attr(el: XElement, local: string): string | undefined {
	return findAttr(el, local)?.value;
}

export function findAttr(el: XElement, local: string): XAttr | undefined {
	for (const a of el.attrs) {
		if (a.local === local && !a.name.startsWith("xmlns")) return a;
	}
	return undefined;
}

/** Concatenated text and CDATA content of an element (direct children only). */
export function text(el: XElement): string {
	let out = "";
	for (const c of el.children) {
		if (c.type !== "element") out += c.value;
	}
	return out;
}

export function descendants(el: XElement, visit: (el: XElement) => void): void {
	for (const c of el.children) {
		if (c.type === "element") {
			visit(c);
			descendants(c, visit);
		}
	}
}
