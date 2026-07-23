import { readdir } from "node:fs/promises";

const directory = new URL("./unit/", import.meta.url);
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".test.js"))
  .sort();

for (const file of files) {
  await import(new URL(file, directory));
}
