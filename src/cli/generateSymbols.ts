import * as fs from "node:fs";
import * as path from "node:path";
import { generateSymbolsForDirectory, loadOverrides, symbolReport, writeSymbolIndex } from "../wombat/symbols";

interface CliArgs {
  scripts: string;
  out: string;
  overrides: string;
  help: boolean;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const scriptsPath = path.resolve(args.scripts);
  if (!fs.existsSync(scriptsPath) || !fs.statSync(scriptsPath).isDirectory()) {
    console.error(`error: scripts directory not found: ${scriptsPath}`);
    return 1;
  }

  const overridesPath = path.resolve(args.overrides);
  ensureOverrides(overridesPath);

  const index = generateSymbolsForDirectory({
    scriptsPath,
    sourceRootLabel: normalizePath(args.scripts),
    overrides: loadOverrides(overridesPath)
  });

  const outPath = path.resolve(args.out);
  writeSymbolIndex(outPath, index);
  console.log(`wrote ${normalizePath(path.relative(process.cwd(), outPath))}`);
  console.log(
    `scripts=${index.counts.scripts} functionSlots=${index.counts.functionSlots} references=${index.counts.resolvedReferences}/${index.counts.references} diagnostics=${index.counts.diagnostics}`
  );

  const reportPath = `${outPath}.report.md`;
  fs.writeFileSync(reportPath, symbolReport(index), "utf8");
  console.log(`wrote ${normalizePath(path.relative(process.cwd(), reportPath))}`);
  return index.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    scripts: "../.rundir/scripts.wombat",
    out: "symbols/symbols.json",
    overrides: "symbols/overrides.json",
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--scripts") {
      args.scripts = requireValue(argv, ++i, arg);
    } else if (arg === "--out") {
      args.out = requireValue(argv, ++i, arg);
    } else if (arg === "--overrides") {
      args.overrides = requireValue(argv, ++i, arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function ensureOverrides(overridesPath: string): void {
  if (fs.existsSync(overridesPath)) {
    return;
  }
  fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
  fs.writeFileSync(overridesPath, '{\n  "schemaVersion": 1,\n  "symbols": {}\n}\n', "utf8");
}

function printHelp(): void {
  console.log(`Usage: npm run generate:symbols -- [options]

Options:
  --scripts <dir>      decoded scripts.wombat directory
  --out <file>         generated symbols.json path
  --overrides <file>   hand-maintained overrides.json path
  -h, --help           show this help
`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
