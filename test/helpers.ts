import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const PROJECT = join(FIXTURES, "project");

export function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}
