/** Small helpers shared by the renderers. */

export function indent(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => (line ? prefix + line : line))
		.join("\n");
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [${text.length - max} more characters; request detail "full" to see all]`;
}

/** Renders `label: value`, moving multi-line values onto their own indented block. */
export function field(label: string, value: string, max = Number.POSITIVE_INFINITY): string {
	const shown = truncate(value.replace(/\r\n/g, "\n").trim(), max);
	return shown.includes("\n") ? `${label}:\n${indent(shown, "    ")}` : `${label}: ${shown}`;
}

/** Orders items so that each comes after the items it depends on; stable, tolerant of cycles. */
export function topoSort<T>(items: T[], id: (item: T) => string, edges: { from: string; to: string }[]): T[] {
	const incoming = new Map<string, number>(items.map((i) => [id(i), 0]));
	for (const e of edges) {
		if (incoming.has(e.to) && incoming.has(e.from)) incoming.set(e.to, incoming.get(e.to)! + 1);
	}
	const out: T[] = [];
	const remaining = [...items];
	while (remaining.length) {
		let index = remaining.findIndex((i) => incoming.get(id(i)) === 0);
		if (index === -1) index = 0; // cycle: emit in original order
		const [next] = remaining.splice(index, 1);
		out.push(next!);
		for (const e of edges) {
			if (e.from === id(next!) && incoming.has(e.to)) incoming.set(e.to, incoming.get(e.to)! - 1);
		}
	}
	return out;
}
