import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAcceptedPacket,
  buildCodexPackets,
  prepareCodexOverrideRun,
  selectOverrideCandidates,
  validateOverridesFile,
  type AcceptedOverrideFile
} from "../wombat/overridePackets";
import { generateSymbolsFromFiles } from "../wombat/symbols";
import type { OverridesFile, SourceFile, SymbolIndex } from "../wombat/types";

describe("Codex override packet workflow", () => {
  it("selects Q function slots and members while skipping existing overrides", () => {
    const fixture = createFixture();
    const candidates = selectOverrideCandidates(fixture.index, {
      schemaVersion: 1,
      symbols: {
        "member:pet:Q5F6": {
          displayName: "activePet"
        }
      }
    });

    expect(candidates.map((candidate) => candidate.symbolId)).toEqual(["function-slot:pet:Q4BY:iil"]);
  });

  it("splits packets deterministically and includes compact source context", () => {
    const fixture = createFixture();
    const candidates = selectOverrideCandidates(fixture.index, { schemaVersion: 1, symbols: {} });
    const packets = buildCodexPackets(fixture.index, candidates, {
      scriptsPath: fixture.scriptsPath,
      maxSymbolsPerPacket: 1,
      maxReferenceSnippets: 2
    });

    expect(packets.map((packet) => packet.packetId)).toEqual(["pet-001", "pet-002"]);
    expect(packets[0].candidates[0]).toMatchObject({
      symbolId: "function-slot:pet:Q4BY:iil",
      kind: "function-slot",
      signature: "int Q4BY(int Q618, list text)"
    });
    expect(packets[0].candidates[0].context.calledBuiltins).toContain("setObjVar");
    expect(packets[0].candidates[0].context.objVars).toContain("petMode");
    expect(packets[0].candidates[0].context.snippets[0].text).toContain("function int Q4BY");
  });

  it("prepares a timestamped run with prompt, progress, and packets", () => {
    const fixture = createFixture();
    const paths = writeRunInputs(fixture.index, { schemaVersion: 1, symbols: {} });
    const result = prepareCodexOverrideRun({
      symbolsPath: paths.symbolsPath,
      overridesPath: paths.overridesPath,
      scriptsPath: fixture.scriptsPath,
      outDir: paths.runsPath,
      maxSymbolsPerPacket: 1,
      now: new Date(2026, 4, 29, 12, 34, 56)
    });

    expect(path.basename(result.runPath)).toBe("20260529-123456");
    expect(result.packetCount).toBe(2);
    expect(fs.readFileSync(path.join(result.runPath, "PROMPT.md"), "utf8")).toContain("Do not edit any .m Wombat source files");
    expect(JSON.parse(fs.readFileSync(path.join(result.runPath, "progress.json"), "utf8"))).toMatchObject({
      packetCount: 2,
      candidateCount: 2
    });
  });

  it("applies accepted names, creates one backup, and updates progress", () => {
    const fixture = createFixture();
    const paths = writeRunInputs(fixture.index, { schemaVersion: 1, symbols: {} });
    const result = prepareCodexOverrideRun({
      symbolsPath: paths.symbolsPath,
      overridesPath: paths.overridesPath,
      scriptsPath: fixture.scriptsPath,
      outDir: paths.runsPath,
      maxSymbolsPerPacket: 1,
      now: new Date(2026, 4, 29, 12, 34, 56)
    });

    writeAccepted(result.runPath, "pet-001", {
      schemaVersion: 1,
      packetId: "pet-001",
      overrides: [
        {
          symbolId: "function-slot:pet:Q4BY:iil",
          displayName: "matchesPetCommandTarget",
          notes: "Checks pet command input and stores pet mode context.",
          confidence: 0.82
        }
      ]
    });

    const applyResult = applyAcceptedPacket({
      runPath: result.runPath,
      packetId: "pet-001",
      now: new Date(2026, 4, 29, 12, 35, 0)
    });

    const overrides = JSON.parse(fs.readFileSync(paths.overridesPath, "utf8")) as OverridesFile;
    expect(overrides.symbols["function-slot:pet:Q4BY:iil"]).toEqual({
      displayName: "matchesPetCommandTarget",
      notes: "Checks pet command input and stores pet mode context.",
      tags: ["codex", "packet:pet-001"]
    });
    expect(fs.existsSync(path.join(result.runPath, applyResult.backupPath ?? ""))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(result.runPath, "progress.json"), "utf8"))).toMatchObject({
      backupPath: "backups/overrides-before-20260529-123500.json",
      packets: [
        {
          packetId: "pet-001",
          status: "applied",
          acceptedCount: 1
        },
        {
          packetId: "pet-002",
          status: "pending"
        }
      ]
    });
  });

  it("rejects malformed accepted names and protects existing overrides", () => {
    const fixture = createFixture();
    const paths = writeRunInputs(fixture.index, {
      schemaVersion: 1,
      symbols: {
        "function-slot:pet:Q4BY:iil": {
          displayName: "existingPetCommandCheck"
        }
      }
    });
    const result = prepareCodexOverrideRun({
      symbolsPath: paths.symbolsPath,
      overridesPath: paths.overridesPath,
      scriptsPath: fixture.scriptsPath,
      outDir: paths.runsPath,
      includeExisting: true,
      maxSymbolsPerPacket: 1
    });

    writeAccepted(result.runPath, "pet-001", {
      schemaVersion: 1,
      packetId: "pet-001",
      overrides: [
        {
          symbolId: "function-slot:pet:Q4BY:iil",
          displayName: "Q4BY"
        }
      ]
    });

    expect(() => applyAcceptedPacket({ runPath: result.runPath, packetId: "pet-001" })).toThrow(/displayName must be lowerCamelCase/);

    writeAccepted(result.runPath, "pet-001", {
      schemaVersion: 1,
      packetId: "pet-001",
      overrides: [
        {
          symbolId: "function-slot:pet:Q4BY:iil",
          displayName: "renamedPetCommandCheck"
        }
      ]
    });

    expect(() => applyAcceptedPacket({ runPath: result.runPath, packetId: "pet-001" })).toThrow(/existing override would be replaced/);
  });

  it("validates full overrides against the active symbol index", () => {
    const fixture = createFixture();
    const issues = validateOverridesFile(fixture.index, {
      schemaVersion: 1,
      symbols: {
        "function-slot:pet:Q4BY:iil": {
          displayName: "process"
        },
        "member:pet:Q5F6": {
          displayName: "activePet"
        },
        "member:pet:Q999": {
          displayName: "missingMember"
        }
      }
    });

    expect(issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "function-slot:pet:Q4BY:iil: displayName is too generic",
        "member:pet:Q999: symbolId does not exist in symbols.json"
      ])
    );
  });
});

function createFixture(): { index: SymbolIndex; scriptsPath: string } {
  const files: SourceFile[] = [
    {
      name: "pet",
      path: "pet.m",
      text: `
member obj Q5F6;

function int Q4BY(int Q618, list text) {
  string phrase;
  phrase = "pet follow";
  setObjVar(this, "petMode", phrase);
  Q5F6 = this;
  return(Q618);
}

function void readable(obj speaker) {
  Q4BY(0x01, text);
  return();
}
`
    }
  ];
  const scriptsPath = fs.mkdtempSync(path.join(os.tmpdir(), "wombat-scripts-"));
  for (const file of files) {
    fs.writeFileSync(path.join(scriptsPath, file.path), file.text, "utf8");
  }
  return {
    index: generateSymbolsFromFiles(files, "fixture"),
    scriptsPath
  };
}

function writeRunInputs(index: SymbolIndex, overrides: OverridesFile): { symbolsPath: string; overridesPath: string; runsPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wombat-codex-run-"));
  const symbolsPath = path.join(root, "symbols.json");
  const overridesPath = path.join(root, "overrides.json");
  const runsPath = path.join(root, "codex-runs");
  fs.writeFileSync(symbolsPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.writeFileSync(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
  return { symbolsPath, overridesPath, runsPath };
}

function writeAccepted(runPath: string, packetId: string, accepted: AcceptedOverrideFile): void {
  fs.writeFileSync(path.join(runPath, "accepted", `${packetId}.json`), `${JSON.stringify(accepted, null, 2)}\n`, "utf8");
}
