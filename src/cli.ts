#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { wisel } from "./client.js";

const program = new Command().name("wisel-story").description("Wisel.my editorial CLI");
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
program.command("health").action(async () => output(await wisel.health()));
program.command("stories").option("-s, --status <status>").action(async o => output(await wisel.list(o.status)));
program.command("get <id>").action(async id => output(await wisel.get(id)));
program.command("create").requiredOption("-f, --file <file>").option("-t, --thumbnail <path>").action(async o => output(await wisel.create(JSON.parse(await readFile(o.file, "utf8")), o.thumbnail)));
program.command("update <id>").requiredOption("-f, --file <file>").action(async (id, o) => output(await wisel.update(id, JSON.parse(await readFile(o.file, "utf8")))));
program.command("publish <id>").action(async id => output(await wisel.publish(id)));
program.command("schedule <id>").requiredOption("--at <iso>").action(async (id, o) => output(await wisel.schedule(id, o.at)));
program.parseAsync().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
