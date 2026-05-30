import { prepareCodexOverrideRun } from "../wombat/overridePackets";

interface CliArgs {
  symbols: string;
  overrides: string;
  scripts: string;
  out: string;
  maxSymbols: number;
  includeExisting: boolean;
  help: boolean;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const result = prepareCodexOverrideRun({
    symbolsPath: args.symbols,
    overridesPath: args.overrides,
    scriptsPath: args.scripts,
    outDir: args.out,
    maxSymbolsPerPacket: args.maxSymbols,
    includeExisting: args.includeExisting
  });

  console.log(`created ${result.runPath}`);
  console.log(`candidates=${result.candidateCount} packets=${result.packetCount}`);
  console.log(`prompt=${result.latestPath ? `${result.latestPath}/PROMPT.md` : `${result.runPath}/PROMPT.md`}`);
  return 0;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    symbols: "symbols/symbols.json",
    overrides: "symbols/overrides.json",
    scripts: "../.rundir/scripts.wombat",
    out: "symbols/codex-runs",
    maxSymbols: 25,
    includeExisting: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--symbols") {
      args.symbols = requireValue(argv, ++i, arg);
    } else if (arg === "--overrides") {
      args.overrides = requireValue(argv, ++i, arg);
    } else if (arg === "--scripts") {
      args.scripts = requireValue(argv, ++i, arg);
    } else if (arg === "--out") {
      args.out = requireValue(argv, ++i, arg);
    } else if (arg === "--max-symbols") {
      args.maxSymbols = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--include-existing") {
      args.includeExisting = true;
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

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: npm run codex:prepare-overrides -- [options]

Options:
  --symbols <file>          symbols.json path
  --overrides <file>        overrides.json path
  --scripts <dir>           decoded scripts.wombat directory
  --out <dir>               codex run output directory
  --max-symbols <count>     max symbols per packet, default 25
  --include-existing        include symbols that already have overrides
  -h, --help                show this help
`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
