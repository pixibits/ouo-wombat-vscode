import { applyAcceptedPacket } from "../wombat/overridePackets";

interface CliArgs {
  run: string;
  packet?: string;
  force: boolean;
  help: boolean;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.packet) {
    throw new Error("missing required --packet <packet-id>");
  }

  const result = applyAcceptedPacket({
    runPath: args.run,
    packetId: args.packet,
    force: args.force
  });

  console.log(`applied ${result.packetId}: ${result.acceptedCount} overrides`);
  console.log(`overrides=${result.overridesPath}`);
  if (result.backupPath) {
    console.log(`backup=${result.backupPath}`);
  }
  console.log(`report=${result.reportPath}`);
  return 0;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    run: "symbols/codex-runs/latest",
    force: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--run") {
      args.run = requireValue(argv, ++i, arg);
    } else if (arg === "--packet") {
      args.packet = requireValue(argv, ++i, arg).replace(/\.json$/i, "");
    } else if (arg === "--force") {
      args.force = true;
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
  console.log(`Usage: npm run codex:apply-packet -- --packet <packet-id> [options]

Options:
  --packet <packet-id>   packet id to apply
  --run <dir>            codex run directory, default symbols/codex-runs/latest
  --force                allow replacing existing overrides
  -h, --help             show this help
`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
