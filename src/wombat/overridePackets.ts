import * as fs from "node:fs";
import * as path from "node:path";
import { tokenize } from "./tokenizer";
import {
  type FunctionDefinitionRecord,
  type FunctionForwardRecord,
  type FunctionParameterShape,
  type FunctionSlotRecord,
  type LocalRecord,
  type MemberRecord,
  type ParameterRecord,
  type OverridesFile,
  type ReferenceRecord,
  type SourceLocation,
  type SourceRange,
  type SymbolIndex,
  type TriggerRecord,
  type SymbolOverride
} from "./types";

export const CODEX_RUN_SCHEMA_VERSION = 1;
export const Q_NAME_PATTERN = /^Q[0-9A-Z]{3}$/;

export type OverrideCandidateKind = "function-slot" | "member" | "param" | "local";
export type ProgressStatus = "pending" | "applied";

export interface SelectOverrideCandidatesOptions {
  includeExisting?: boolean;
}

export interface OverrideCandidate {
  symbolId: string;
  kind: OverrideCandidateKind;
  obfuscatedName: string;
  script: string;
  existingOverride?: SymbolOverride;
}

export interface PacketBuildOptions {
  scriptsPath: string;
  maxSymbolsPerPacket?: number;
  maxReferenceSnippets?: number;
  maxDeclarationLines?: number;
}

export interface CodexPacket {
  schemaVersion: 1;
  packetId: string;
  script: string;
  scripts: string[];
  instructions: string[];
  candidates: CodexPacketCandidate[];
  acceptedOutputSchema: {
    schemaVersion: 1;
    packetId: string;
    overrides: Array<{
      symbolId: string;
      displayName: "lowerCamelCase";
      notes?: "short rationale or uncertainty";
      confidence?: "optional number from 0 to 1";
      tags?: "optional string array";
    }>;
  };
}

export interface CodexPacketCandidate {
  symbolId: string;
  kind: OverrideCandidateKind;
  obfuscatedName: string;
  script: string;
  type?: string;
  signature?: string;
  originScript?: string;
  functionDefinitions?: FunctionDefinitionSummary[];
  functionForwards?: FunctionForwardSummary[];
  memberInheritance?: MemberInheritanceSummary;
  existingOverride?: SymbolOverride;
  context: CandidateContext;
}

export interface FunctionDefinitionSummary {
  id: string;
  script: string;
  signature: string;
  returnType: string;
  params: string[];
  overrides?: string;
  overriddenBy: string[];
}

export interface FunctionForwardSummary {
  id: string;
  script: string;
  signature: string;
  returnType: string;
  params: string[];
}

export interface MemberInheritanceSummary {
  declaredIn: string;
  inheritedBy: string[];
}

export interface CandidateContext {
  declarations: ContextLocation[];
  references: ContextReference[];
  snippets: SourceSnippet[];
  strings: string[];
  objVars: string[];
  calledBuiltins: string[];
}

export interface ContextLocation {
  id?: string;
  kind: "definition" | "forward" | "member";
  path: string;
  line: number;
}

export interface ContextReference {
  path: string;
  line: number;
  containerId: string;
  targetId?: string;
  definitionTargetId?: string;
}

export interface SourceSnippet {
  label: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface PrepareCodexRunOptions {
  symbolsPath: string;
  overridesPath: string;
  scriptsPath: string;
  outDir: string;
  includeExisting?: boolean;
  maxSymbolsPerPacket?: number;
  now?: Date;
}

export interface PrepareCodexRunResult {
  runId: string;
  runPath: string;
  packetCount: number;
  candidateCount: number;
  latestPath?: string;
}

export interface CodexProgressFile {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  symbolsPath: string;
  overridesPath: string;
  scriptsPath: string;
  candidateCount: number;
  packetCount: number;
  backupPath?: string;
  packets: CodexProgressPacket[];
}

export interface CodexProgressPacket {
  packetId: string;
  path: string;
  status: ProgressStatus;
  candidateCount: number;
  acceptedPath: string;
  reportPath: string;
  appliedAt?: string;
  acceptedCount?: number;
}

export interface AcceptedOverrideFile {
  schemaVersion: 1;
  packetId: string;
  overrides: AcceptedOverride[];
}

export interface AcceptedOverride {
  symbolId: string;
  displayName: string;
  notes?: string;
  confidence?: number;
  tags?: string[];
}

export interface ApplyPacketOptions {
  runPath: string;
  packetId: string;
  force?: boolean;
  allowAuditWarnings?: boolean;
  now?: Date;
}

export interface ApplyPacketResult {
  packetId: string;
  acceptedCount: number;
  overridesPath: string;
  backupPath?: string;
  reportPath: string;
}

export interface OverrideValidationIssue {
  severity: "error" | "warning";
  message: string;
  symbolId?: string;
}

export interface AuditAcceptedRunOptions {
  runPath: string;
  packetId?: string;
}

export interface AuditAcceptedRunResult {
  runPath: string;
  packetCount: number;
  acceptedPacketCount: number;
  issues: OverrideValidationIssue[];
}

const DEFAULT_MAX_SYMBOLS_PER_PACKET = 25;
const DEFAULT_MAX_REFERENCE_SNIPPETS = 12;
const DEFAULT_MAX_DECLARATION_LINES = 36;
const MAX_HINTS = 25;

const wombatReservedWords = new Set([
  "break",
  "case",
  "continue",
  "default",
  "else",
  "for",
  "forward",
  "function",
  "goto",
  "if",
  "inherits",
  "int",
  "list",
  "loc",
  "member",
  "obj",
  "return",
  "string",
  "switch",
  "trigger",
  "ustring",
  "void",
  "while"
]);

const genericNames = new Set(["data", "doThing", "execute", "helper", "process", "run", "thing", "unknown", "value"]);
const broadAcceptedNames = new Set([
  "amount",
  "count",
  "createdObject",
  "index",
  "items",
  "locationLocation",
  "locationValue",
  "lookAtTextText",
  "messageValue",
  "object",
  "objectObject",
  "objectValue",
  "randomValue",
  "result",
  "text",
  "value"
]);

const callWordsToIgnore = new Set([
  ...wombatReservedWords,
  "true",
  "false",
  "null"
]);

export function selectOverrideCandidates(
  index: SymbolIndex,
  overrides: OverridesFile,
  options: SelectOverrideCandidatesOptions = {}
): OverrideCandidate[] {
  const includeExisting = options.includeExisting === true;
  const hasOverride = (id: string) => Object.prototype.hasOwnProperty.call(overrides.symbols, id);
  const candidates: OverrideCandidate[] = [];

  for (const slot of index.functionSlots) {
    if (!Q_NAME_PATTERN.test(slot.name) || (!includeExisting && hasOverride(slot.id))) {
      continue;
    }
    candidates.push({
      symbolId: slot.id,
      kind: "function-slot",
      obfuscatedName: slot.name,
      script: slot.originScript,
      existingOverride: overrides.symbols[slot.id]
    });
  }

  for (const member of index.members) {
    if (!Q_NAME_PATTERN.test(member.name) || (!includeExisting && hasOverride(member.id))) {
      continue;
    }
    candidates.push({
      symbolId: member.id,
      kind: "member",
      obfuscatedName: member.name,
      script: member.script,
      existingOverride: overrides.symbols[member.id]
    });
  }

  for (const param of index.params) {
    if (!Q_NAME_PATTERN.test(param.name ?? "") || (!includeExisting && hasOverride(param.id))) {
      continue;
    }
    candidates.push({
      symbolId: param.id,
      kind: "param",
      obfuscatedName: param.name,
      script: param.script,
      existingOverride: overrides.symbols[param.id]
    });
  }

  for (const local of index.locals) {
    if (!Q_NAME_PATTERN.test(local.name) || (!includeExisting && hasOverride(local.id))) {
      continue;
    }
    candidates.push({
      symbolId: local.id,
      kind: "local",
      obfuscatedName: local.name,
      script: local.script,
      existingOverride: overrides.symbols[local.id]
    });
  }

  return candidates.sort((a, b) => {
    const scriptCmp = a.script.localeCompare(b.script);
    if (scriptCmp !== 0) {
      return scriptCmp;
    }
    const kindCmp = candidateKindRank(a.kind) - candidateKindRank(b.kind);
    if (kindCmp !== 0) {
      return kindCmp;
    }
    return a.symbolId.localeCompare(b.symbolId);
  });
}

export function buildCodexPackets(index: SymbolIndex, candidates: OverrideCandidate[], options: PacketBuildOptions): CodexPacket[] {
  const maxSymbolsPerPacket = Math.max(1, options.maxSymbolsPerPacket ?? DEFAULT_MAX_SYMBOLS_PER_PACKET);
  const context = new PacketContextBuilder(index, options);
  const packets: CodexPacket[] = [];
  let mixedPacketOrdinal = 1;
  let pendingSmallGroup: OverrideCandidate[] = [];

  for (const [script, scriptCandidates] of groupedByScript(candidates)) {
    if (scriptCandidates.length > maxSymbolsPerPacket) {
      flushPendingSmallGroup();
      let part = 1;
      for (let offset = 0; offset < scriptCandidates.length; offset += maxSymbolsPerPacket) {
        const chunk = scriptCandidates.slice(offset, offset + maxSymbolsPerPacket);
        packets.push(createPacket(`${safePathPart(script)}-${String(part).padStart(3, "0")}`, chunk, context));
        part++;
      }
      continue;
    }

    if (pendingSmallGroup.length + scriptCandidates.length > maxSymbolsPerPacket) {
      flushPendingSmallGroup();
    }
    pendingSmallGroup.push(...scriptCandidates);
  }

  flushPendingSmallGroup();
  return packets;

  function flushPendingSmallGroup(): void {
    if (pendingSmallGroup.length === 0) {
      return;
    }
    const scripts = uniqueStrings(pendingSmallGroup.map((candidate) => candidate.script));
    const packetId =
      scripts.length === 1
        ? `${safePathPart(scripts[0])}-001`
        : `packet-${String(mixedPacketOrdinal++).padStart(3, "0")}`;
    packets.push(createPacket(packetId, pendingSmallGroup, context));
    pendingSmallGroup = [];
  }
}

export function prepareCodexOverrideRun(options: PrepareCodexRunOptions): PrepareCodexRunResult {
  const symbolsPath = path.resolve(options.symbolsPath);
  const overridesPath = path.resolve(options.overridesPath);
  const scriptsPath = path.resolve(options.scriptsPath);
  const outDir = path.resolve(options.outDir);

  const index = readJsonFile<SymbolIndex>(symbolsPath);
  const overrides = fs.existsSync(overridesPath)
    ? readJsonFile<OverridesFile>(overridesPath)
    : ({ schemaVersion: CODEX_RUN_SCHEMA_VERSION, symbols: {} } satisfies OverridesFile);

  if (!fs.existsSync(scriptsPath) || !fs.statSync(scriptsPath).isDirectory()) {
    throw new Error(`scripts directory not found: ${scriptsPath}`);
  }

  const candidates = selectOverrideCandidates(index, overrides, { includeExisting: options.includeExisting });
  const packets = buildCodexPackets(index, candidates, {
    scriptsPath,
    maxSymbolsPerPacket: options.maxSymbolsPerPacket
  });

  const now = options.now ?? new Date();
  const runId = uniqueRunId(outDir, formatRunId(now));
  const runPath = path.join(outDir, runId);
  fs.mkdirSync(path.join(runPath, "packets"), { recursive: true });
  fs.mkdirSync(path.join(runPath, "accepted"), { recursive: true });
  fs.mkdirSync(path.join(runPath, "reports"), { recursive: true });
  fs.mkdirSync(path.join(runPath, "backups"), { recursive: true });

  for (const packet of packets) {
    writeJsonFile(path.join(runPath, "packets", `${packet.packetId}.json`), packet);
  }

  const progress: CodexProgressFile = {
    schemaVersion: CODEX_RUN_SCHEMA_VERSION,
    runId,
    createdAt: now.toISOString(),
    symbolsPath: normalizePath(path.relative(process.cwd(), symbolsPath)),
    overridesPath: normalizePath(path.relative(process.cwd(), overridesPath)),
    scriptsPath: normalizePath(path.relative(process.cwd(), scriptsPath)),
    candidateCount: candidates.length,
    packetCount: packets.length,
    packets: packets.map((packet) => ({
      packetId: packet.packetId,
      path: normalizePath(path.join("packets", `${packet.packetId}.json`)),
      status: "pending",
      candidateCount: packet.candidates.length,
      acceptedPath: normalizePath(path.join("accepted", `${packet.packetId}.json`)),
      reportPath: normalizePath(path.join("reports", `${packet.packetId}.md`))
    }))
  };

  writeJsonFile(path.join(runPath, "progress.json"), progress);
  fs.writeFileSync(path.join(runPath, "PROMPT.md"), renderPrompt(progress), "utf8");

  const latestPath = refreshLatestPointer(outDir, runId);
  writeJsonFile(path.join(outDir, "latest.json"), {
    schemaVersion: CODEX_RUN_SCHEMA_VERSION,
    runId,
    path: normalizePath(path.relative(process.cwd(), runPath))
  });

  return {
    runId,
    runPath,
    latestPath,
    packetCount: packets.length,
    candidateCount: candidates.length
  };
}

export function applyAcceptedPacket(options: ApplyPacketOptions): ApplyPacketResult {
  const runPath = resolveRunPath(options.runPath);
  const progressPath = path.join(runPath, "progress.json");
  const progress = readJsonFile<CodexProgressFile>(progressPath);
  const packetProgress = progress.packets.find((packet) => packet.packetId === options.packetId);
  if (!packetProgress) {
    throw new Error(`packet not found in progress.json: ${options.packetId}`);
  }

  const packet = readJsonFile<CodexPacket>(path.join(runPath, packetProgress.path));
  const acceptedPath = path.join(runPath, packetProgress.acceptedPath);
  if (!fs.existsSync(acceptedPath)) {
    throw new Error(`accepted packet file not found: ${acceptedPath}`);
  }
  const accepted = readJsonFile<AcceptedOverrideFile>(acceptedPath);
  const overridesPath = resolveProgressPath(progress.overridesPath);
  const overrides = fs.existsSync(overridesPath)
    ? readJsonFile<OverridesFile>(overridesPath)
    : ({ schemaVersion: CODEX_RUN_SCHEMA_VERSION, symbols: {} } satisfies OverridesFile);

  const validationIssues = validateAcceptedPacket(packet, accepted, overrides, { force: options.force });
  const errors = validationIssues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map(formatIssue).join("\n"));
  }

  const auditIssues = auditAcceptedPacket(packet, accepted);
  const auditBlockers = auditIssues.filter((issue) => issue.severity === "error" || options.allowAuditWarnings !== true);
  if (auditBlockers.length > 0) {
    throw new Error(
      [
        "accepted override audit found names that need manual review",
        ...auditBlockers.map(formatIssue),
        "rerun with --allow-audit-warnings only after reviewing these names"
      ].join("\n")
    );
  }

  let backupPath = progress.backupPath ? path.join(runPath, progress.backupPath) : undefined;
  if (!backupPath && accepted.overrides.length > 0) {
    backupPath = path.join("backups", `overrides-before-${formatRunId(options.now ?? new Date())}.json`);
    const absoluteBackupPath = path.join(runPath, backupPath);
    fs.mkdirSync(path.dirname(absoluteBackupPath), { recursive: true });
    if (fs.existsSync(overridesPath)) {
      fs.copyFileSync(overridesPath, absoluteBackupPath);
    } else {
      writeJsonFile(absoluteBackupPath, { schemaVersion: CODEX_RUN_SCHEMA_VERSION, symbols: {} });
    }
    progress.backupPath = normalizePath(backupPath);
  }

  for (const acceptedOverride of accepted.overrides) {
    const current = overrides.symbols[acceptedOverride.symbolId];
    const tags = uniqueStrings([...(current?.tags ?? []), ...(acceptedOverride.tags ?? []), "codex", `packet:${packet.packetId}`]);
    overrides.symbols[acceptedOverride.symbolId] = withoutUndefined({
      displayName: acceptedOverride.displayName,
      notes: acceptedOverride.notes ?? current?.notes,
      tags
    });
  }

  writeOverridesFile(overridesPath, overrides);

  const appliedAt = (options.now ?? new Date()).toISOString();
  packetProgress.status = "applied";
  packetProgress.appliedAt = appliedAt;
  packetProgress.acceptedCount = accepted.overrides.length;
  writeJsonFile(progressPath, sortProgress(progress));

  const reportPath = path.join(runPath, packetProgress.reportPath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderApplyReport(packet, accepted, [...validationIssues, ...auditIssues], appliedAt), "utf8");

  return {
    packetId: packet.packetId,
    acceptedCount: accepted.overrides.length,
    overridesPath,
    backupPath: progress.backupPath,
    reportPath
  };
}

export function validateAcceptedPacket(
  packet: CodexPacket,
  accepted: AcceptedOverrideFile,
  overrides: OverridesFile,
  options: { force?: boolean } = {}
): OverrideValidationIssue[] {
  const issues: OverrideValidationIssue[] = [];
  if (accepted.schemaVersion !== CODEX_RUN_SCHEMA_VERSION) {
    issues.push({ severity: "error", message: "accepted file schemaVersion must be 1" });
  }
  if (accepted.packetId !== packet.packetId) {
    issues.push({
      severity: "error",
      message: `accepted packetId '${accepted.packetId}' does not match active packet '${packet.packetId}'`
    });
  }
  if (!Array.isArray(accepted.overrides)) {
    issues.push({ severity: "error", message: "accepted overrides must be an array" });
    return issues;
  }

  const activeIds = new Set(packet.candidates.map((candidate) => candidate.symbolId));
  const seen = new Set<string>();
  for (const acceptedOverride of accepted.overrides) {
    const prefix = acceptedOverride.symbolId ? `${acceptedOverride.symbolId}: ` : "";
    if (!activeIds.has(acceptedOverride.symbolId)) {
      issues.push({
        severity: "error",
        symbolId: acceptedOverride.symbolId,
        message: `${prefix}symbolId is not in active packet`
      });
      continue;
    }
    if (seen.has(acceptedOverride.symbolId)) {
      issues.push({
        severity: "error",
        symbolId: acceptedOverride.symbolId,
        message: `${prefix}duplicate accepted override`
      });
    }
    seen.add(acceptedOverride.symbolId);

    issues.push(...validateDisplayName(acceptedOverride.displayName, acceptedOverride.symbolId));
    if (!options.force && Object.prototype.hasOwnProperty.call(overrides.symbols, acceptedOverride.symbolId)) {
      issues.push({
        severity: "error",
        symbolId: acceptedOverride.symbolId,
        message: `${prefix}existing override would be replaced; rerun with --force to allow this`
      });
    }
    if (acceptedOverride.confidence !== undefined && (acceptedOverride.confidence < 0 || acceptedOverride.confidence > 1)) {
      issues.push({
        severity: "error",
        symbolId: acceptedOverride.symbolId,
        message: `${prefix}confidence must be between 0 and 1`
      });
    }
    if (needsNotes(acceptedOverride) && !nonEmptyString(acceptedOverride.notes)) {
      issues.push({
        severity: "error",
        symbolId: acceptedOverride.symbolId,
        message: `${prefix}notes are required for low-confidence or ambiguous guesses`
      });
    }
  }

  return issues;
}

export function auditAcceptedRun(options: AuditAcceptedRunOptions): AuditAcceptedRunResult {
  const runPath = resolveRunPath(options.runPath);
  const progress = readJsonFile<CodexProgressFile>(path.join(runPath, "progress.json"));
  const packetId = options.packetId?.replace(/\.json$/i, "");
  const selectedPackets = packetId ? progress.packets.filter((packet) => packet.packetId === packetId) : progress.packets;
  const issues: OverrideValidationIssue[] = [];
  let acceptedPacketCount = 0;

  if (packetId && selectedPackets.length === 0) {
    return {
      runPath,
      packetCount: 0,
      acceptedPacketCount: 0,
      issues: [
        {
          severity: "error",
          message: `packet not found in progress.json: ${packetId}`
        }
      ]
    };
  }

  for (const packetProgress of selectedPackets) {
    const acceptedPath = path.join(runPath, packetProgress.acceptedPath);
    if (!fs.existsSync(acceptedPath)) {
      if (packetId) {
        issues.push({
          severity: "error",
          message: `accepted packet file not found: ${acceptedPath}`
        });
      }
      continue;
    }

    acceptedPacketCount++;
    const packet = readJsonFile<CodexPacket>(path.join(runPath, packetProgress.path));
    const accepted = readJsonFile<AcceptedOverrideFile>(acceptedPath);
    issues.push(...auditAcceptedPacket(packet, accepted));
  }

  return {
    runPath,
    packetCount: selectedPackets.length,
    acceptedPacketCount,
    issues
  };
}

export function auditAcceptedPacket(packet: CodexPacket, accepted: AcceptedOverrideFile): OverrideValidationIssue[] {
  const issues: OverrideValidationIssue[] = [];
  const candidatesById = new Map(packet.candidates.map((candidate) => [candidate.symbolId, candidate]));
  const acceptedByScopeAndName = new Map<string, AcceptedOverride[]>();

  for (const override of accepted.overrides) {
    const candidate = candidatesById.get(override.symbolId);
    const prefix = `${packet.packetId}: ${override.symbolId}: `;

    if (!candidate) {
      continue;
    }

    if ((override.confidence ?? 1) <= 0.7) {
      issues.push({
        severity: "warning",
        symbolId: override.symbolId,
        message: `${prefix}low-confidence accepted name '${override.displayName}' should be manually reviewed`
      });
    }
    if (/fallback name/i.test(override.notes ?? "")) {
      issues.push({
        severity: "warning",
        symbolId: override.symbolId,
        message: `${prefix}fallback accepted name '${override.displayName}' should be omitted or replaced with a context-specific role`
      });
    }
    if (isBroadAcceptedName(override.displayName, candidate, override.confidence)) {
      issues.push({
        severity: "warning",
        symbolId: override.symbolId,
        message: `${prefix}broad accepted name '${override.displayName}' may hide more than it explains`
      });
    }

    const scopeKey = `${candidateScopeKey(candidate)}\u0000${override.displayName}`;
    const group = acceptedByScopeAndName.get(scopeKey);
    if (group) {
      group.push(override);
    } else {
      acceptedByScopeAndName.set(scopeKey, [override]);
    }
  }

  for (const [scopeKey, overrides] of acceptedByScopeAndName) {
    if (overrides.length < 2) {
      continue;
    }
    const [scope, displayName] = scopeKey.split("\u0000");
    issues.push({
      severity: "warning",
      symbolId: overrides[0].symbolId,
      message: `${packet.packetId}: ${scope}: ${overrides.length} accepted overrides use '${displayName}'; prefer distinct role names or omit ambiguous locals`
    });
  }

  return issues;
}

export function validateOverridesFile(index: SymbolIndex, overrides: OverridesFile): OverrideValidationIssue[] {
  const issues: OverrideValidationIssue[] = [];
  if (overrides.schemaVersion !== CODEX_RUN_SCHEMA_VERSION) {
    issues.push({ severity: "error", message: "overrides schemaVersion must be 1" });
  }
  if (!overrides.symbols || typeof overrides.symbols !== "object" || Array.isArray(overrides.symbols)) {
    issues.push({ severity: "error", message: "overrides symbols must be an object" });
    return issues;
  }

  const validIds = new Set([
    ...index.functionSlots.map((record) => record.id),
    ...index.functions.map((record) => record.id),
    ...index.forwards.map((record) => record.id),
    ...index.members.map((record) => record.id),
    ...index.params.map((record) => record.id),
    ...index.locals.map((record) => record.id)
  ]);

  for (const [symbolId, override] of Object.entries(overrides.symbols)) {
    if (!validIds.has(symbolId)) {
      issues.push({ severity: "error", symbolId, message: `${symbolId}: symbolId does not exist in symbols.json` });
    }
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      issues.push({ severity: "error", symbolId, message: `${symbolId}: override must be an object` });
      continue;
    }
    if (override.displayName !== undefined) {
      issues.push(...validateDisplayName(override.displayName, symbolId));
    }
    if (override.notes !== undefined && typeof override.notes !== "string") {
      issues.push({ severity: "error", symbolId, message: `${symbolId}: notes must be a string` });
    }
    if (override.tags !== undefined && (!Array.isArray(override.tags) || override.tags.some((tag) => typeof tag !== "string"))) {
      issues.push({ severity: "error", symbolId, message: `${symbolId}: tags must be a string array` });
    }
  }

  return issues;
}

export function writeOverridesFile(overridesPath: string, overrides: OverridesFile): void {
  writeJsonFile(overridesPath, sortOverrides(overrides));
}

export function readSymbolIndex(symbolsPath: string): SymbolIndex {
  return readJsonFile<SymbolIndex>(symbolsPath);
}

export function readOverridesFile(overridesPath: string): OverridesFile {
  if (!fs.existsSync(overridesPath)) {
    return { schemaVersion: CODEX_RUN_SCHEMA_VERSION, symbols: {} };
  }
  return readJsonFile<OverridesFile>(overridesPath);
}

function groupedByScript(candidates: OverrideCandidate[]): Array<[string, OverrideCandidate[]]> {
  const groups = new Map<string, OverrideCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.script);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(candidate.script, [candidate]);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function createPacket(packetId: string, candidates: OverrideCandidate[], context: PacketContextBuilder): CodexPacket {
  const scripts = uniqueStrings(candidates.map((candidate) => candidate.script));
  return {
    schemaVersion: CODEX_RUN_SCHEMA_VERSION,
    packetId,
    script: scripts.length === 1 ? scripts[0] : scripts.join(","),
    scripts,
    instructions: [
      "Infer human-readable lowerCamelCase display names for the listed Wombat Qxxx symbols, including function slots, members, parameters, and locals.",
      "Only include symbols when the proposed name is supported by the packet context.",
      "Omit candidates whose role is ambiguous; a shorter accepted file is better than generic filler names.",
      "Do not write scripts, helper tools, or bulk heuristics to generate names. Review this packet directly.",
      "Use notes for uncertainty, ambiguity, or any name that is more of an informed guess.",
      "Do not edit Wombat .m source files or compiled script files."
    ],
    candidates: candidates.map((candidate) => context.buildCandidate(candidate)),
    acceptedOutputSchema: {
      schemaVersion: CODEX_RUN_SCHEMA_VERSION,
      packetId,
      overrides: [
        {
          symbolId: "symbol ID from this packet",
          displayName: "lowerCamelCase",
          notes: "short rationale or uncertainty",
          confidence: "optional number from 0 to 1",
          tags: "optional string array"
        }
      ]
    }
  };
}

class PacketContextBuilder {
  private readonly slotsById: Map<string, FunctionSlotRecord>;
  private readonly membersById: Map<string, MemberRecord>;
  private readonly paramsById: Map<string, ParameterRecord>;
  private readonly localsById: Map<string, LocalRecord>;
  private readonly functionsById: Map<string, FunctionDefinitionRecord>;
  private readonly forwardsById: Map<string, FunctionForwardRecord>;
  private readonly triggersById: Map<string, TriggerRecord>;
  private readonly referencesByTargetId: Map<string, ReferenceRecord[]>;
  private readonly sourceCache: SourceCache;
  private readonly maxReferenceSnippets: number;
  private readonly maxDeclarationLines: number;

  constructor(
    private readonly index: SymbolIndex,
    options: PacketBuildOptions
  ) {
    this.slotsById = new Map(index.functionSlots.map((record) => [record.id, record]));
    this.membersById = new Map(index.members.map((record) => [record.id, record]));
    this.paramsById = new Map(index.params.map((record) => [record.id, record]));
    this.localsById = new Map(index.locals.map((record) => [record.id, record]));
    this.functionsById = new Map(index.functions.map((record) => [record.id, record]));
    this.forwardsById = new Map(index.forwards.map((record) => [record.id, record]));
    this.triggersById = new Map(index.triggers.map((record) => [record.id, record]));
    this.referencesByTargetId = buildReferencesByTargetId(index.references);
    this.sourceCache = new SourceCache(options.scriptsPath);
    this.maxReferenceSnippets = options.maxReferenceSnippets ?? DEFAULT_MAX_REFERENCE_SNIPPETS;
    this.maxDeclarationLines = options.maxDeclarationLines ?? DEFAULT_MAX_DECLARATION_LINES;
  }

  buildCandidate(candidate: OverrideCandidate): CodexPacketCandidate {
    switch (candidate.kind) {
      case "function-slot":
        return this.buildFunctionCandidate(candidate);
      case "member":
        return this.buildMemberCandidate(candidate);
      case "param":
        return this.buildParamCandidate(candidate);
      case "local":
        return this.buildLocalCandidate(candidate);
    }
    throw new Error(`unsupported override candidate kind: ${candidate.kind}`);
  }

  private buildFunctionCandidate(candidate: OverrideCandidate): CodexPacketCandidate {
    const slot = required(this.slotsById.get(candidate.symbolId), `missing function slot ${candidate.symbolId}`);
    const definitions = slot.definitionIds.map((id) => this.functionsById.get(id)).filter(isDefined);
    const forwards = slot.forwardIds.map((id) => this.forwardsById.get(id)).filter(isDefined);
    const references = this.referencesByTargetId.get(slot.id) ?? [];
    const snippets: SourceSnippetWithRaw[] = [];

    for (const definition of definitions) {
      snippets.push(
        this.snippetForRange(
          `definition ${definition.id}`,
          definition.location,
          definition.bodyRange ? mergeLocationAndRange(definition.location, definition.bodyRange) : definition.location,
          1,
          this.maxDeclarationLines
        )
      );
    }
    for (const forward of forwards) {
      snippets.push(this.snippetForRange(`forward ${forward.id}`, forward.location, forward.location, 1, 6));
    }
    snippets.push(...this.referenceSnippets(references));

    const hints = collectContextHints(snippets.map((snippet) => snippet.raw), slot.name);

    return {
      symbolId: slot.id,
      kind: "function-slot",
      obfuscatedName: slot.name,
      script: slot.originScript,
      originScript: slot.originScript,
      type: slot.returnType,
      signature: formatFunctionSignature(slot.name, slot.returnType, slot.params),
      functionDefinitions: definitions.map((definition) => ({
        id: definition.id,
        script: definition.script,
        signature: definition.signature,
        returnType: definition.returnType,
        params: formatParams(definition.params),
        overrides: definition.overrides,
        overriddenBy: [...definition.overriddenBy].sort()
      })),
      functionForwards: forwards.map((forward) => ({
        id: forward.id,
        script: forward.script,
        signature: forward.signature,
        returnType: forward.returnType,
        params: formatParams(forward.params)
      })),
      existingOverride: candidate.existingOverride,
      context: {
        declarations: [
          ...definitions.map((definition) => contextLocation("definition", definition.id, definition.location)),
          ...forwards.map((forward) => contextLocation("forward", forward.id, forward.location))
        ],
        references: references.slice(0, this.maxReferenceSnippets).map(referenceSummary),
        snippets: snippets.map(stripRawSnippet),
        strings: hints.strings,
        objVars: hints.objVars,
        calledBuiltins: hints.calledBuiltins
      }
    };
  }

  private buildMemberCandidate(candidate: OverrideCandidate): CodexPacketCandidate {
    const member = required(this.membersById.get(candidate.symbolId), `missing member ${candidate.symbolId}`);
    const references = this.referencesByTargetId.get(member.id) ?? [];
    const snippets = [
      this.snippetForRange(`member ${member.id}`, member.location, member.location, 2, 6),
      ...this.referenceSnippets(references)
    ];
    const hints = collectContextHints(snippets.map((snippet) => snippet.raw), member.name);

    return {
      symbolId: member.id,
      kind: "member",
      obfuscatedName: member.name,
      script: member.script,
      type: `${member.type} member`,
      existingOverride: candidate.existingOverride,
      memberInheritance: {
        declaredIn: member.script,
        inheritedBy: [...member.inheritedBy].sort()
      },
      context: {
        declarations: [contextLocation("member", member.id, member.location)],
        references: references.slice(0, this.maxReferenceSnippets).map(referenceSummary),
        snippets: snippets.map(stripRawSnippet),
        strings: hints.strings,
        objVars: hints.objVars,
        calledBuiltins: hints.calledBuiltins
      }
    };
  }

  private buildParamCandidate(candidate: OverrideCandidate): CodexPacketCandidate {
    const param = required(this.paramsById.get(candidate.symbolId), `missing param ${candidate.symbolId}`);
    return this.buildVariableCandidate(candidate, param, "param");
  }

  private buildLocalCandidate(candidate: OverrideCandidate): CodexPacketCandidate {
    const local = required(this.localsById.get(candidate.symbolId), `missing local ${candidate.symbolId}`);
    return this.buildVariableCandidate(candidate, local, "local");
  }

  private buildVariableCandidate(
    candidate: OverrideCandidate,
    variable: ParameterRecord | LocalRecord,
    kind: "param" | "local"
  ): CodexPacketCandidate {
    const noun = kind === "param" ? "parameter" : "local variable";
    const references = this.referencesByTargetId.get(variable.id) ?? [];
    const snippets = [
      this.snippetForRange(`${noun} ${variable.id}`, variable.location, variable.location, 2, 6),
      ...optionalSnippet(this.containerSnippet(variable.containerId)),
      ...this.referenceSnippets(references)
    ];
    const hints = collectContextHints(snippets.map((snippet) => snippet.raw), variable.name);

    return {
      symbolId: variable.id,
      kind,
      obfuscatedName: variable.name,
      script: variable.script,
      type: `${variable.type} ${noun}`,
      existingOverride: candidate.existingOverride,
      context: {
        declarations: [contextLocation("definition", variable.id, variable.location)],
        references: references.slice(0, this.maxReferenceSnippets).map(referenceSummary),
        snippets: snippets.map(stripRawSnippet),
        strings: hints.strings,
        objVars: hints.objVars,
        calledBuiltins: hints.calledBuiltins
      }
    };
  }

  private containerSnippet(containerId: string): SourceSnippetWithRaw | undefined {
    const definition = this.functionsById.get(containerId);
    if (definition) {
      return this.snippetForRange(
        `containing function ${definition.id}`,
        definition.location,
        definition.bodyRange ? mergeLocationAndRange(definition.location, definition.bodyRange) : definition.location,
        1,
        this.maxDeclarationLines
      );
    }

    const trigger = this.triggersById.get(containerId);
    if (trigger) {
      return this.snippetForRange(
        `containing trigger ${trigger.id}`,
        trigger.location,
        trigger.bodyRange ? mergeLocationAndRange(trigger.location, trigger.bodyRange) : trigger.location,
        1,
        this.maxDeclarationLines
      );
    }

    return undefined;
  }

  private referenceSnippets(references: ReferenceRecord[]): SourceSnippetWithRaw[] {
    const snippets: SourceSnippetWithRaw[] = [];
    const seen = new Set<string>();
    for (const reference of references.slice(0, this.maxReferenceSnippets)) {
      const key = `${reference.location.path}:${reference.location.range.start.line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      snippets.push(this.snippetForRange(`reference in ${reference.containerId}`, reference.location, reference.location, 1, 5));
    }
    return snippets;
  }

  private snippetForRange(
    label: string,
    location: SourceLocation,
    rangeLocation: SourceLocation,
    contextLines: number,
    maxLines: number
  ): SourceSnippetWithRaw {
    return this.sourceCache.snippet(label, location.path, rangeLocation.range, contextLines, maxLines);
  }
}

class SourceCache {
  private readonly files = new Map<string, string | undefined>();

  constructor(private readonly scriptsPath: string) {}

  snippet(label: string, filePath: string, range: SourceRange, contextLines: number, maxLines: number): SourceSnippetWithRaw {
    const text = this.read(filePath);
    if (text === undefined) {
      return {
        label,
        path: filePath,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        text: `source file not found: ${filePath}`,
        raw: ""
      };
    }

    const lines = text.split(/\r?\n/);
    const startLine = Math.max(0, range.start.line - contextLines);
    const desiredEndLine = Math.max(range.end.line + contextLines, range.start.line);
    const endLine = Math.min(lines.length - 1, Math.min(desiredEndLine, startLine + maxLines - 1));
    const slice = lines.slice(startLine, endLine + 1);
    const numbered = slice.map((line, offset) => `${String(startLine + offset + 1).padStart(4, " ")}: ${line}`).join("\n");

    return {
      label,
      path: filePath,
      startLine: startLine + 1,
      endLine: endLine + 1,
      text: numbered,
      raw: slice.join("\n")
    };
  }

  private read(filePath: string): string | undefined {
    const normalized = normalizePath(filePath);
    if (this.files.has(normalized)) {
      return this.files.get(normalized);
    }
    const absolute = path.join(this.scriptsPath, normalized);
    if (!fs.existsSync(absolute)) {
      this.files.set(normalized, undefined);
      return undefined;
    }
    const text = fs.readFileSync(absolute, "utf8");
    this.files.set(normalized, text);
    return text;
  }
}

interface SourceSnippetWithRaw extends SourceSnippet {
  raw: string;
}

interface ContextHints {
  strings: string[];
  objVars: string[];
  calledBuiltins: string[];
}

function collectContextHints(rawSnippets: string[], obfuscatedName: string): ContextHints {
  const strings: string[] = [];
  const objVars: string[] = [];
  const calls: string[] = [];

  for (const raw of rawSnippets) {
    const { tokens } = tokenize(raw);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.type === "string") {
        pushUnique(strings, token.text);
      }
      if (token.type === "identifier" && tokens[index + 1]?.text === "(") {
        if (!Q_NAME_PATTERN.test(token.text) && token.text !== obfuscatedName && !callWordsToIgnore.has(token.text)) {
          pushUnique(calls, token.text);
        }
        if (/objvar/i.test(token.text)) {
          for (const value of stringArgsUntilMatchingParen(tokens, index + 1)) {
            pushUnique(objVars, value);
          }
        }
      }
    }
  }

  return {
    strings: strings.slice(0, MAX_HINTS),
    objVars: objVars.slice(0, MAX_HINTS),
    calledBuiltins: calls.slice(0, MAX_HINTS)
  };
}

function stringArgsUntilMatchingParen(tokens: ReturnType<typeof tokenize>["tokens"], openParenIndex: number): string[] {
  const values: string[] = [];
  let depth = 0;
  for (let index = openParenIndex; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.text === "(") {
      depth++;
    } else if (token.text === ")") {
      depth--;
      if (depth === 0) {
        break;
      }
    } else if (depth > 0 && token.type === "string") {
      values.push(token.text);
    }
  }
  return values;
}

function buildReferencesByTargetId(references: ReferenceRecord[]): Map<string, ReferenceRecord[]> {
  const byTarget = new Map<string, ReferenceRecord[]>();
  for (const reference of references) {
    for (const targetId of uniqueStrings([reference.targetId, reference.definitionTargetId].filter(isDefined))) {
      const group = byTarget.get(targetId);
      if (group) {
        group.push(reference);
      } else {
        byTarget.set(targetId, [reference]);
      }
    }
  }
  for (const group of byTarget.values()) {
    group.sort((a, b) => a.id.localeCompare(b.id));
  }
  return byTarget;
}

function validateDisplayName(displayName: unknown, symbolId: string): OverrideValidationIssue[] {
  const issues: OverrideValidationIssue[] = [];
  const prefix = `${symbolId}: `;
  if (!nonEmptyString(displayName)) {
    return [{ severity: "error", symbolId, message: `${prefix}displayName must be a non-empty string` }];
  }
  if (!/^[a-z][A-Za-z0-9]*$/.test(displayName)) {
    issues.push({ severity: "error", symbolId, message: `${prefix}displayName must be lowerCamelCase identifier text` });
  }
  if (Q_NAME_PATTERN.test(displayName)) {
    issues.push({ severity: "error", symbolId, message: `${prefix}displayName must not be a Qxxx name` });
  }
  if (wombatReservedWords.has(displayName)) {
    issues.push({ severity: "error", symbolId, message: `${prefix}displayName must not be a Wombat keyword or type` });
  }
  if (genericNames.has(displayName)) {
    issues.push({ severity: "error", symbolId, message: `${prefix}displayName is too generic` });
  }
  return issues;
}

function isBroadAcceptedName(displayName: string, candidate: CodexPacketCandidate, confidence: number | undefined): boolean {
  if (broadAcceptedNames.has(displayName)) {
    return true;
  }
  if (candidate.kind !== "param" && candidate.kind !== "local") {
    return false;
  }
  if ((confidence ?? 1) > 0.78) {
    return false;
  }
  return /(?:Result|Object|Value|Text|Items|Count|Location)$/.test(displayName);
}

function candidateScopeKey(candidate: CodexPacketCandidate): string {
  const match = /^(?:local|param):([^:]+):([^:]+):/.exec(candidate.symbolId);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }
  return candidate.script;
}

function needsNotes(override: AcceptedOverride): boolean {
  if (override.confidence !== undefined && override.confidence < 0.7) {
    return true;
  }
  return (override.tags ?? []).some((tag) => /ambiguous|uncertain|low-confidence/i.test(tag));
}

function renderPrompt(progress: CodexProgressFile): string {
  return `# Codex-Assisted Wombat Override Naming

You are populating display-name metadata for Wombat Qxxx symbols, including function slots, members, parameters, and locals. Work locally in this repository. Do not edit any .m Wombat source files, compiled bytecode, or generated symbols.json by hand.

## Run
- Run ID: ${progress.runId}
- Packets: ${progress.packetCount}
- Candidate symbols: ${progress.candidateCount}
- Symbols path: ${progress.symbolsPath}
- Overrides path: ${progress.overridesPath}
- Scripts path: ${progress.scriptsPath}

Packet, accepted, report, and progress paths are relative to the directory containing this PROMPT.md file.

## Guardrails
- Before every packet, re-read this PROMPT.md, progress.json, and the active packets/*.json file.
- Do not use, copy, merge, or summarize accepted files from older runs or other run IDs.
- Do not create helper scripts, regex pipelines, bulk heuristics, or automated naming tools for the packets.
- If a candidate is ambiguous, omit it. A smaller high-confidence accepted file is better than filler.
- After writing each accepted file, run \`npm run codex:audit-accepted -- --packet <packet-id>\` and apply it only if the audit passes.

## Workflow
1. Re-open progress.json and pick the first packet whose status is "pending".
2. Re-read that packet from its packets/*.json file.
3. Infer lowerCamelCase displayName values for Qxxx function slots, members, parameters, and locals using only the packet context.
4. Write accepted/<packet-id>.json with this schema:

\`\`\`json
{
  "schemaVersion": 1,
  "packetId": "<packet-id>",
  "overrides": [
    {
      "symbolId": "<symbol ID from this packet>",
      "displayName": "lowerCamelCaseName",
      "notes": "short rationale, especially if uncertain",
      "confidence": 0.8,
      "tags": ["optional"]
    }
  ]
}
\`\`\`

The overrides array may be shorter than the candidate list. Omit any candidate whose role is unclear.

5. Run \`npm run codex:audit-accepted -- --packet <packet-id>\`.
6. If the audit passes, run \`npm run codex:apply-packet -- --packet <packet-id>\`.
7. Run \`npm run codex:validate-overrides\`.
8. Continue until all packets are applied.

## Naming Rules
- Only use symbolId values from the active packet.
- displayName must be lowerCamelCase.
- Do not use Qxxx names, Wombat keywords/types, empty names, or generic names like helper/process/run/value.
- Avoid broad bucket names like count/result/index/object/value unless that is truly the symbol's specific role and notes explain why.
- Avoid scriptStemResult/scriptStemObject/scriptStemValue names. These are usually signs that the context was not understood.
- Preserve existing overrides unless the user explicitly asks for --force.
- Add notes when a name is uncertain, low-confidence, or based on partial context.

After all packets are complete, run:

\`\`\`sh
npm run generate:symbols -- --scripts ../.rundir/scripts.wombat --out symbols/symbols.json --overrides symbols/overrides.json
npm test
\`\`\`
`;
}

function renderApplyReport(
  packet: CodexPacket,
  accepted: AcceptedOverrideFile,
  issues: OverrideValidationIssue[],
  appliedAt: string
): string {
  const lines = [
    `# Packet ${packet.packetId}`,
    "",
    `Applied at: ${appliedAt}`,
    `Accepted overrides: ${accepted.overrides.length}`,
    ""
  ];

  if (accepted.overrides.length > 0) {
    lines.push("## Overrides", "");
    for (const override of accepted.overrides) {
      const notes = override.notes ? ` - ${override.notes}` : "";
      lines.push(`- ${override.symbolId}: ${override.displayName}${notes}`);
    }
    lines.push("");
  }

  const warnings = issues.filter((issue) => issue.severity === "warning");
  if (warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of warnings) {
      lines.push(`- ${formatIssue(warning)}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function refreshLatestPointer(outDir: string, runId: string): string | undefined {
  const latestPath = path.join(outDir, "latest");
  fs.rmSync(latestPath, { recursive: true, force: true });
  try {
    fs.symlinkSync(runId, latestPath, "dir");
    return latestPath;
  } catch {
    fs.mkdirSync(latestPath, { recursive: true });
    writeJsonFile(path.join(latestPath, "latest.json"), {
      schemaVersion: CODEX_RUN_SCHEMA_VERSION,
      runId,
      path: normalizePath(path.join("..", runId))
    });
    fs.writeFileSync(
      path.join(latestPath, "PROMPT.md"),
      `# Latest Wombat Codex Run\n\nOpen ../${runId}/PROMPT.md for the current run.\n`,
      "utf8"
    );
    return latestPath;
  }
}

function resolveRunPath(runPath: string): string {
  const absolute = path.resolve(runPath);
  const progressPath = path.join(absolute, "progress.json");
  if (fs.existsSync(progressPath)) {
    return absolute;
  }
  const latestJson = path.join(absolute, "latest.json");
  if (fs.existsSync(latestJson)) {
    const pointer = readJsonFile<{ path: string }>(latestJson);
    return path.resolve(absolute, pointer.path);
  }
  throw new Error(`run path does not contain progress.json: ${absolute}`);
}

function resolveProgressPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function sortOverrides(overrides: OverridesFile): OverridesFile {
  const sorted: OverridesFile = { schemaVersion: CODEX_RUN_SCHEMA_VERSION, symbols: {} };
  for (const [symbolId, override] of Object.entries(overrides.symbols).sort(([a], [b]) => a.localeCompare(b))) {
    const tags = override.tags ? [...override.tags].sort((a, b) => a.localeCompare(b)) : undefined;
    sorted.symbols[symbolId] = withoutUndefined({
      displayName: override.displayName,
      notes: override.notes,
      tags
    });
  }
  return sorted;
}

function sortProgress(progress: CodexProgressFile): CodexProgressFile {
  return {
    ...progress,
    packets: [...progress.packets]
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatRunId(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

function uniqueRunId(outDir: string, base: string): string {
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(path.join(outDir, candidate))) {
    candidate = `${base}-${String(suffix).padStart(3, "0")}`;
    suffix++;
  }
  return candidate;
}

function referenceSummary(reference: ReferenceRecord): ContextReference {
  return withoutUndefined({
    path: reference.location.path,
    line: reference.location.range.start.line + 1,
    containerId: reference.containerId,
    targetId: reference.targetId,
    definitionTargetId: reference.definitionTargetId
  });
}

function contextLocation(kind: ContextLocation["kind"], id: string, location: SourceLocation): ContextLocation {
  return {
    id,
    kind,
    path: location.path,
    line: location.range.start.line + 1
  };
}

function mergeLocationAndRange(location: SourceLocation, range: SourceRange): SourceLocation {
  return {
    path: location.path,
    range: {
      start: location.range.start,
      end: range.end
    }
  };
}

function stripRawSnippet(snippet: SourceSnippetWithRaw): SourceSnippet {
  return {
    label: snippet.label,
    path: snippet.path,
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    text: snippet.text
  };
}

function formatFunctionSignature(name: string, returnType: string, params: FunctionParameterShape[]): string {
  return `${returnType} ${name}(${formatParams(params).join(", ")})`;
}

function formatParams(params: FunctionParameterShape[]): string[] {
  return params.map((param) => (param.name ? `${param.type} ${param.name}` : param.type));
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatIssue(issue: OverrideValidationIssue): string {
  return issue.symbolId && !issue.message.startsWith(issue.symbolId) ? `${issue.symbolId}: ${issue.message}` : issue.message;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function optionalSnippet(value: SourceSnippetWithRaw | undefined): SourceSnippetWithRaw[] {
  return value ? [value] : [];
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function candidateKindRank(kind: OverrideCandidateKind): number {
  switch (kind) {
    case "function-slot":
      return 0;
    case "member":
      return 1;
    case "param":
      return 2;
    case "local":
      return 3;
  }
}
