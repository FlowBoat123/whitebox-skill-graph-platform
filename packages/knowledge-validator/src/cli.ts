#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { compileGraph, serializeGraph } from "./compile-graph.js";
import { loadRegistry } from "./load-registry.js";
import type {
  CliIo,
  RegistryCounts,
  ValidationDiagnostic,
  ValidationOptions,
} from "./types.js";
import { validateRegistry } from "./validate-registry.js";

type Command = "validate" | "build";

interface ParsedArguments {
  command: Command;
  root?: string;
  output?: string;
  asOf?: string;
  json: boolean;
}

class CliUsageError extends Error {}

const USAGE = `Usage:
  knowledge-validator validate [--root <path>] [--as-of YYYY-MM-DD] [--json]
  knowledge-validator build [--root <path>] [--output <path>] [--as-of YYYY-MM-DD]`;

function parseArguments(args: string[]): ParsedArguments {
  const [commandValue, ...options] = args;
  if (commandValue !== "validate" && commandValue !== "build") {
    throw new CliUsageError(commandValue === "--help" || commandValue === "-h" ? USAGE : `Unknown command\n${USAGE}`);
  }

  const parsed: ParsedArguments = { command: commandValue, json: false };
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--json") {
      if (commandValue !== "validate") {
        throw new CliUsageError("--json is supported only by validate");
      }
      parsed.json = true;
      continue;
    }
    if (option === "--root" || option === "--output" || option === "--as-of") {
      const value = options[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`Missing value for ${option}`);
      }
      index += 1;
      if (option === "--root") {
        parsed.root = value;
      } else if (option === "--output") {
        if (commandValue !== "build") {
          throw new CliUsageError("--output is supported only by build");
        }
        parsed.output = value;
      } else {
        parsed.asOf = value;
      }
      continue;
    }
    throw new CliUsageError(`Unknown option: ${option}`);
  }

  if (parsed.asOf !== undefined && !isRealIsoDate(parsed.asOf)) {
    throw new CliUsageError("--as-of must be a real date in YYYY-MM-DD form");
  }
  return parsed;
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isRepositoryRoot(directory: string): boolean {
  const packagePath = path.join(directory, "package.json");
  if (!existsSync(packagePath)) {
    return false;
  }
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
    return (
      (packageJson.name === "whitebox-skill-graph-platform" ||
        packageJson.name === "defect-intelligence-platform") &&
      existsSync(path.join(directory, "contracts", "knowledge")) &&
      existsSync(path.join(directory, "knowledge"))
    );
  } catch {
    return false;
  }
}

function discoverRoot(start: string): string {
  let candidate = path.resolve(start);
  while (true) {
    if (isRepositoryRoot(candidate)) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }

  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  if (isRepositoryRoot(sourceRoot)) {
    return sourceRoot;
  }
  throw new CliUsageError(`Unable to locate registry root from ${start}; pass --root explicitly`);
}

function formatCounts(counts: RegistryCounts): string[] {
  return [
    `Defect families: ${counts.defectFamilies}`,
    `Invariants: ${counts.invariants}`,
    `Guardrails: ${counts.guardrails}`,
    `Bugs: ${counts.bugs}`,
  ];
}

function formatDiagnostics(errors: ValidationDiagnostic[]): string {
  const lines: string[] = [];
  for (const error of errors) {
    lines.push(`ERROR ${error.file}`);
    lines.push(`  ${error.path}:`);
    lines.push(`  ${error.message}`);
  }
  return lines.join("\n");
}

function containsFatalReadError(errors: ValidationDiagnostic[]): boolean {
  return errors.some(
    (error) =>
      error.code === "LOAD_ERROR" &&
      (error.file === "knowledge" || error.file === "contracts/knowledge" || /Unable to read/u.test(error.message)),
  );
}

function defaultIo(): CliIo {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    env: process.env,
  };
}

export async function runCli(args: string[], io: CliIo = defaultIo()): Promise<number> {
  try {
    const parsed = parseArguments(args);
    const invocationDirectory = io.env?.INIT_CWD ?? process.env.INIT_CWD ?? process.cwd();
    const root =
      parsed.root === undefined
        ? discoverRoot(invocationDirectory)
        : path.resolve(invocationDirectory, parsed.root);
    const registry = await loadRegistry(root);
    const validationOptions: ValidationOptions = {
      asOf: parsed.asOf ?? new Date().toISOString().slice(0, 10),
    };
    const validation = validateRegistry(registry, validationOptions);

    if (!validation.valid) {
      if (parsed.json) {
        io.stdout(`${JSON.stringify(validation, null, 2)}\n`);
      } else {
        io.stderr(`${formatDiagnostics(validation.errors)}\n`);
      }
      return containsFatalReadError(validation.errors) ? 2 : 1;
    }

    if (parsed.command === "validate") {
      if (parsed.json) {
        io.stdout(`${JSON.stringify(validation, null, 2)}\n`);
      } else {
        io.stdout(`${["Knowledge registry valid", ...formatCounts(validation.counts)].join("\n")}\n`);
      }
      return 0;
    }

    const graph = compileGraph(registry, validationOptions);
    const output =
      parsed.output === undefined
        ? path.join(root, "build", "knowledge-index.json")
        : path.resolve(invocationDirectory, parsed.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serializeGraph(graph), "utf8");
    io.stdout(
      `${[
        "Knowledge graph built",
        `Output: ${output}`,
        `Nodes: ${graph.nodes.length}`,
        `Edges: ${graph.edges.length}`,
        `Source digest: ${graph.sourceDigest}`,
      ].join("\n")}\n`,
    );
    return 0;
  } catch (error) {
    const debug = io.env?.DEBUG === "true" || process.env.DEBUG === "true";
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    if (debug && error instanceof Error && error.stack !== undefined) {
      io.stderr(`${error.stack}\n`);
    } else {
      io.stderr(`${error instanceof Error ? error.message : "Unexpected error"}\n`);
    }
    return 2;
  }
}

const executable = process.argv[1];
const isMainModule =
  executable !== undefined &&
  (() => {
    try {
      return (
        pathToFileURL(realpathSync(path.resolve(executable))).href ===
        pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
      );
    } catch {
      return pathToFileURL(path.resolve(executable)).href === import.meta.url;
    }
  })();
if (isMainModule) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
