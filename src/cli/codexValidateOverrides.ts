import { readOverridesFile, readSymbolIndex, validateOverridesFile } from "../wombat/overridePackets";

interface CliArgs {
  symbols: string;
  overrides: string;
  help: boolean;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const index = readSymbolIndex(args.symbols);
  const overrides = readOverridesFile(args.overrides);
  const issues = validateOverridesFile(index, overrides);
  for (const issue of issues) {
    console.error(`${issue.severity}: ${issue.message}`);
  }
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    console.error(`invalid overrides: ${errors.length} error(s), ${issues.length - errors.length} warning(s)`);
    return 1;
  }

  console.log(`valid overrides: ${Object.keys(overrides.symbols).length} entries`);
  return 0;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    symbols: "symbols/symbols.json",
    overrides: "symbols/overrides.json",
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

function printHelp(): void {
  console.log(`Usage: npm run codex:validate-overrides -- [options]

Options:
  --symbols <file>     symbols.json path
  --overrides <file>   overrides.json path
  -h, --help           show this help
`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
