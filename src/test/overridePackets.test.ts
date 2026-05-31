import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAcceptedPacket,
  auditAcceptedPacket,
  buildCodexPackets,
  prepareCodexOverrideRun,
  selectOverrideCandidates,
  validateOverridesFile,
  type AcceptedOverrideFile
} from "../wombat/overridePackets";
import { generateSymbolsFromFiles } from "../wombat/symbols";
import type { OverridesFile, SourceFile, SymbolIndex } from "../wombat/types";

describe("Codex override packet workflow", () => {
  it("selects Q function slots, parameters, and locals while skipping existing overrides", () => {
    const fixture = createFixture();
    const candidates = selectOverrideCandidates(fixture.index, {
      schemaVersion: 1,
      symbols: {
        "member:pet:Q5F6": {
          displayName: "activePet"
        }
      }
    });

    expect(candidates.map((candidate) => `${candidate.kind}:${candidate.obfuscatedName}`)).toEqual([
      "function-slot:Q4BY",
      "param:Q618",
      "local:Q4V9"
    ]);
  });

  it("splits packets deterministically and includes compact source context", () => {
    const fixture = createFixture();
    const candidates = selectOverrideCandidates(fixture.index, { schemaVersion: 1, symbols: {} });
    const packets = buildCodexPackets(fixture.index, candidates, {
      scriptsPath: fixture.scriptsPath,
      maxSymbolsPerPacket: 2,
      maxReferenceSnippets: 2
    });

    expect(packets.map((packet) => packet.packetId)).toEqual(["pet-001", "pet-002"]);
    expect(packets[0].candidates.map((candidate) => candidate.kind)).toEqual(["function-slot", "member"]);
    expect(packets[0].candidates[0]).toMatchObject({
      symbolId: "function-slot:pet:Q4BY:iil",
      kind: "function-slot",
      signature: "int Q4BY(int Q618, list text)"
    });
    expect(packets[0].candidates[0].context.calledBuiltins).toContain("setObjVar");
    expect(packets[0].candidates[0].context.objVars).toContain("petMode");
    expect(packets[0].candidates[0].context.snippets[0].text).toContain("function int Q4BY");
    expect(packets[1].candidates.map((candidate) => candidate.kind)).toEqual(["param", "local"]);
    expect(packets[1].candidates[0]).toMatchObject({
      kind: "param",
      obfuscatedName: "Q618"
    });
    expect(packets[1].candidates[0].context.snippets[1]).toMatchObject({
      label: "containing function function-def:pet:Q4BY:iil"
    });
    expect(packets[1].candidates[0].context.snippets[1].text).toContain("return(Q618)");
    expect(packets[1].candidates[1]).toMatchObject({
      kind: "local",
      obfuscatedName: "Q4V9"
    });
  });

  it("prepares a timestamped run with prompt, progress, and packets", () => {
    const fixture = createFixture();
    const paths = writeRunInputs(fixture.index, { schemaVersion: 1, symbols: {} });
    const result = prepareCodexOverrideRun({
      symbolsPath: paths.symbolsPath,
      overridesPath: paths.overridesPath,
      scriptsPath: fixture.scriptsPath,
      outDir: paths.runsPath,
      maxSymbolsPerPacket: 2,
      now: new Date(2026, 4, 29, 12, 34, 56)
    });

    expect(path.basename(result.runPath)).toBe("20260529-123456");
    expect(result.packetCount).toBe(2);
    const prompt = fs.readFileSync(path.join(result.runPath, "PROMPT.md"), "utf8");
    expect(prompt).toContain("Do not edit any .m Wombat source files");
    expect(prompt).toContain("Before every packet, re-read this PROMPT.md, progress.json");
    expect(prompt).toContain("Do not use, copy, merge, or summarize accepted files from older runs");
    expect(JSON.parse(fs.readFileSync(path.join(result.runPath, "progress.json"), "utf8"))).toMatchObject({
      packetCount: 2,
      candidateCount: 4
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
      maxSymbolsPerPacket: 2,
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
      maxSymbolsPerPacket: 2
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

  it("audits and blocks broad duplicate accepted names", () => {
    const fixture = createFixture();
    const paths = writeRunInputs(fixture.index, { schemaVersion: 1, symbols: {} });
    const result = prepareCodexOverrideRun({
      symbolsPath: paths.symbolsPath,
      overridesPath: paths.overridesPath,
      scriptsPath: fixture.scriptsPath,
      outDir: paths.runsPath,
      maxSymbolsPerPacket: 2
    });
    const paramId = fixture.index.params.find((record) => record.name === "Q618")?.id;
    const localId = fixture.index.locals.find((record) => record.name === "Q4V9")?.id;
    expect(paramId).toBeDefined();
    expect(localId).toBeDefined();
    const packet = JSON.parse(fs.readFileSync(path.join(result.runPath, "packets", "pet-002.json"), "utf8"));
    const accepted: AcceptedOverrideFile = {
      schemaVersion: 1,
      packetId: "pet-002",
      overrides: [
        {
          symbolId: paramId!,
          displayName: "count",
          confidence: 0.92
        },
        {
          symbolId: localId!,
          displayName: "count",
          confidence: 0.92
        }
      ]
    };

    const auditMessages = auditAcceptedPacket(packet, accepted).map((issue) => issue.message);
    expect(auditMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("broad accepted name 'count'"),
        expect.stringContaining("2 accepted overrides use 'count'")
      ])
    );

    writeAccepted(result.runPath, "pet-002", accepted);
    expect(() => applyAcceptedPacket({ runPath: result.runPath, packetId: "pet-002" })).toThrow(/accepted override audit/);
    expect(() =>
      applyAcceptedPacket({ runPath: result.runPath, packetId: "pet-002", allowAuditWarnings: true })
    ).not.toThrow();
  });

  it("validates full overrides against the active symbol index", () => {
    const fixture = createFixture();
    const paramId = fixture.index.params.find((record) => record.name === "Q618")?.id;
    const localId = fixture.index.locals.find((record) => record.name === "Q4V9")?.id;
    expect(paramId).toBeDefined();
    expect(localId).toBeDefined();
    const issues = validateOverridesFile(fixture.index, {
      schemaVersion: 1,
      symbols: {
        "function-slot:pet:Q4BY:iil": {
          displayName: "process"
        },
        "member:pet:Q5F6": {
          displayName: "activePet"
        },
        [paramId!]: {
          displayName: "petCommandInput"
        },
        [localId!]: {
          displayName: "commandCounter"
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
  int Q4V9;
  string phrase;
  Q4V9 = Q618 + 0x01;
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
