import { escapeAttr, escapeText, findAttr, type XElement } from "../dtsx/xml.ts";

/**
 * Text-level edit primitives. Each returns splices against the original
 * source, so everything that is not touched stays byte-identical and diffs
 * stay small.
 */
export interface Splice {
	start: number;
	end: number;
	text: string;
}

export function applySplices(source: string, splices: Splice[]): string {
	const ordered = splices.map((s, i) => ({ ...s, i })).sort((a, b) => b.start - a.start || b.i - a.i);
	let out = source;
	let floor = Number.POSITIVE_INFINITY;
	for (const s of ordered) {
		if (s.end > floor) throw new Error("Internal error: overlapping edits");
		out = out.slice(0, s.start) + s.text + out.slice(s.end);
		floor = s.start;
	}
	return out;
}

export function eolOf(source: string): string {
	return source.includes("\r\n") ? "\r\n" : "\n";
}

function lineStart(source: string, offset: number): number {
	return source.lastIndexOf("\n", offset - 1) + 1;
}

/** Leading whitespace of the line an element starts on. */
export function indentOf(source: string, el: XElement): string {
	const start = lineStart(source, el.start);
	const lead = source.slice(start, el.start);
	return /^\s*$/.test(lead) ? lead : (/^\s*/.exec(lead)?.[0] ?? "");
}

/** True when nothing but whitespace precedes the offset on its line. */
function startsLine(source: string, offset: number): boolean {
	return /^[ \t]*$/.test(source.slice(lineStart(source, offset), offset));
}

function usesAttributePerLine(source: string, el: XElement): boolean {
	const first = el.attrs[0];
	if (first) return source.slice(el.start, first.start).includes("\n");
	// No attributes to copy the style from: follow the document root.
	let root = el;
	while (root.parent) root = root.parent;
	return root.attrs.length > 1 && source.slice(root.attrs[0]!.valueEnd, root.attrs[1]!.start).includes("\n");
}

export function setAttr(source: string, el: XElement, name: string, value: string): Splice[] {
	const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
	const existing = findAttr(el, local);
	if (existing) return [{ start: existing.valueStart, end: existing.valueEnd, text: escapeAttr(value) }];
	let at = el.startTagClose;
	while (at > 0 && /\s/.test(source[at - 1]!)) at--;
	const separator = usesAttributePerLine(source, el) ? `${eolOf(source)}${indentOf(source, el)}  ` : " ";
	return [{ start: at, end: at, text: `${separator}${name}="${escapeAttr(value)}"` }];
}

export function removeAttr(source: string, el: XElement, local: string): Splice[] {
	const existing = findAttr(el, local);
	if (!existing) return [];
	let start = existing.start;
	while (start > 0 && /\s/.test(source[start - 1]!)) start--;
	return [{ start, end: existing.valueEnd + 1, text: "" }];
}

/** Stands in for newlines inside text content so re-indenting cannot alter values. */
const TEXT_NEWLINE = "\u0001";

/** Re-indents generated XML (written with \n and two-space nesting) for its destination. */
function place(xml: string, indent: string, eol: string): string {
	return xml
		.split("\n")
		.map((line) => indent + line)
		.join(eol)
		.replaceAll(TEXT_NEWLINE, eol);
}

/** Inserts `xml` as a child of `parent`, before `before` or as the last child. */
export function insertChild(source: string, parent: XElement, xml: string, before?: XElement): Splice[] {
	const eol = eolOf(source);
	const parentIndent = indentOf(source, parent);
	const childIndent = `${parentIndent}  `;
	const block = place(xml, childIndent, eol);

	if (parent.selfClosing) {
		let at = parent.startTagClose;
		while (at > 0 && /\s/.test(source[at - 1]!)) at--;
		return [{ start: at, end: parent.end, text: `>${eol}${block}${eol}${parentIndent}</${parent.name}>` }];
	}
	if (before) {
		if (startsLine(source, before.start)) {
			const at = lineStart(source, before.start);
			return [{ start: at, end: at, text: `${block}${eol}` }];
		}
		return [{ start: before.start, end: before.start, text: `${block}${eol}${childIndent}` }];
	}
	if (startsLine(source, parent.contentEnd)) {
		const at = lineStart(source, parent.contentEnd);
		return [{ start: at, end: at, text: `${block}${eol}` }];
	}
	return [{ start: parent.contentEnd, end: parent.contentEnd, text: `${eol}${block}${eol}${parentIndent}` }];
}

export function removeElement(source: string, el: XElement): Splice[] {
	let start = el.start;
	let end = el.end;
	if (startsLine(source, el.start)) {
		start = lineStart(source, el.start);
		if (source.startsWith("\r\n", end)) end += 2;
		else if (source[end] === "\n") end += 1;
	}
	return [{ start, end, text: "" }];
}

export function setText(source: string, el: XElement, value: string): Splice[] {
	if (el.selfClosing) {
		let at = el.startTagClose;
		while (at > 0 && /\s/.test(source[at - 1]!)) at--;
		return [{ start: at, end: el.end, text: `>${escapeText(value)}</${el.name}>` }];
	}
	return [{ start: el.contentStart, end: el.contentEnd, text: escapeText(value) }];
}

/** Builds an element in the designer's layout: one attribute per line, two-space nesting. */
export function element(name: string, attrs: [string, string | undefined][], content?: string[] | { text: string }, trailingAttr?: string): string {
	const present = attrs.filter((a): a is [string, string] => a[1] !== undefined);
	let open = `<${name}`;
	for (const [k, v] of present) open += `\n  ${k}="${escapeAttr(v)}"`;
	if (trailingAttr) open += ` ${trailingAttr}`;
	if (content === undefined) return `${open} />`;
	if (!Array.isArray(content)) return `${open}>${escapeText(content.text).replace(/\r?\n/g, TEXT_NEWLINE)}</${name}>`;
	const children = content.map((c) =>
		c
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n"),
	);
	return `${open}>\n${children.join("\n")}\n</${name}>`;
}
