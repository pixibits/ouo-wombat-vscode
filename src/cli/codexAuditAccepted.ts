import { auditAcceptedRun } from "../wombat/overridePackets";

interface CliArgs {
  run: string;
  packet?: string;
  help: boolean;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const result = auditAcceptedRun({
    runPath: args.run,
    packetId: args.packet
  });

  for (const issue of result.issues) {
    console.error(`${issue.severity}: ${issue.message}`);
  }

  if (result.issues.length > 0) {
    console.error(
      `accepted override audit needs review: ${result.issues.length} issue(s), ${result.acceptedPacketCount}/${result.packetCount} accepted packet(s)`
    );
    return 1;
  }

  console.log(`accepted override audit passed: ${result.acceptedPacketCount}/${result.packetCount} packet(s)`);
  return 0;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    run: "symbols/codex-runs/latest",
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
  console.log(`Usage: npm run codex:audit-accepted -- [options]

Options:
  --run <dir>            codex run directory, default symbols/codex-runs/latest
  --packet <packet-id>   audit one accepted packet
  -h, --help             show this help
`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
