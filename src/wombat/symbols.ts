import * as fs from "node:fs";
import * as path from "node:path";
import { parseSourceFile, type ParsedFunction, type ParsedScript } from "./parser";
import {
  SYMBOL_SCHEMA_VERSION,
  type DiagnosticRecord,
  type FunctionDefinitionRecord,
  type FunctionForwardRecord,
  type FunctionParameterShape,
  type FunctionSlotRecord,
  type LocalRecord,
  type MemberRecord,
  type OverridesFile,
  type ParameterRecord,
  type ReferenceRecord,
  type ScriptRecord,
  type SourceFile,
  type SymbolIndex,
  type SymbolOverride,
  type TriggerRecord
} from "./types";

export interface GenerateOptions {
  scriptsPath: string;
  sourceRootLabel?: string;
  overrides?: OverridesFile;
}

interface SlotKey {
  name: string;
  signature: string;
}

interface FunctionDeclRef {
  script: string;
  declaration: ParsedFunction;
}

interface ContainerScope {
  script: string;
  containerId: string;
  params: ParameterRecord[];
  locals: LocalRecord[];
}

export function readScriptsFromDirectory(scriptsPath: string): SourceFile[] {
  const entries = fs
    .readdirSync(scriptsPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".m"))
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries.map((entry) => {
    const fullPath = path.join(scriptsPath, entry.name);
    return {
      path: entry.name.replace(/\\/g, "/"),
      name: path.basename(entry.name, ".m"),
      text: fs.readFileSync(fullPath, "utf8")
    };
  });
}

export function loadOverrides(overridesPath: string | undefined): OverridesFile {
  if (!overridesPath || !fs.existsSync(overridesPath)) {
    return { schemaVersion: 1, symbols: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(overridesPath, "utf8")) as Partial<OverridesFile>;
  return {
    schemaVersion: 1,
    symbols: parsed.symbols ?? {}
  };
}

export function generateSymbolsForDirectory(options: GenerateOptions): SymbolIndex {
  const files = readScriptsFromDirectory(options.scriptsPath);
  return generateSymbolsFromFiles(files, options.sourceRootLabel ?? normalizePath(options.scriptsPath), options.overrides);
}

export function generateSymbolsFromFiles(
  files: SourceFile[],
  sourceRoot: string,
  overrides: OverridesFile = { schemaVersion: 1, symbols: {} }
): SymbolIndex {
  const diagnostics: DiagnosticRecord[] = [];
  const parsed = files.map(parseSourceFile).sort((a, b) => a.name.localeCompare(b.name));
  for (const script of parsed) {
    diagnostics.push(...script.diagnostics);
  }

  const scriptByName = new Map(parsed.map((script) => [script.name, script]));
  const inheritance: Record<string, string | null> = {};
  for (const script of parsed) {
    inheritance[script.name] = script.parent ?? null;
    if (script.parent && !scriptByName.has(script.parent)) {
      diagnostics.push({
        severity: "warning",
        script: script.name,
        message: `Script '${script.name}' inherits missing parent '${script.parent}'.`,
        location: script.parentLocation
      });
    }
  }

  const ancestorMemo = new Map<string, string[]>();
  const ancestorChain = (scriptName: string, visiting = new Set<string>()): string[] => {
    const memo = ancestorMemo.get(scriptName);
    if (memo) {
      return memo;
    }
    const script = scriptByName.get(scriptName);
    if (!script) {
      return [];
    }
    if (visiting.has(scriptName)) {
      diagnostics.push({
        severity: "error",
        script: scriptName,
        message: `Inheritance cycle includes '${scriptName}'.`
      });
      return [scriptName];
    }
    visiting.add(scriptName);
    const chain = script.parent && scriptByName.has(script.parent) ? [...ancestorChain(script.parent, visiting), scriptName] : [scriptName];
    visiting.delete(scriptName);
    ancestorMemo.set(scriptName, chain);
    return chain;
  };

  for (const script of parsed) {
    ancestorChain(script.name);
  }

  const declarationsByScript = new Map<string, Map<string, FunctionDeclRef[]>>();
  const declarationsByScriptAndName = new Map<string, Map<string, Set<string>>>();

  for (const script of parsed) {
    const byKey = new Map<string, FunctionDeclRef[]>();
    const byName = new Map<string, Set<string>>();
    for (const declaration of [...script.forwards, ...script.functions]) {
      const key = functionKey(declaration);
      pushMapArray(byKey, key, { script: script.name, declaration });
      if (!byName.has(declaration.name)) {
        byName.set(declaration.name, new Set());
      }
      byName.get(declaration.name)?.add(declaration.signature);
    }
    declarationsByScript.set(script.name, byKey);
    declarationsByScriptAndName.set(script.name, byName);
  }

  const slotById = new Map<string, FunctionSlotRecord>();
  const functionRecords = new Map<string, FunctionDefinitionRecord>();
  const forwardRecords = new Map<string, FunctionForwardRecord>();
  const paramRecords: ParameterRecord[] = [];
  const localRecords: LocalRecord[] = [];
  const triggerRecords: TriggerRecord[] = [];
  const memberRecords = new Map<string, MemberRecord>();
  const containerScopes = new Map<string, ContainerScope>();

  const findOrigin = (scriptName: string, declaration: ParsedFunction): string => {
    const key = functionKey(declaration);
    for (const ancestor of ancestorChain(scriptName)) {
      if (declarationsByScript.get(ancestor)?.has(key)) {
        return ancestor;
      }
    }
    return scriptName;
  };

  const ensureSlot = (scriptName: string, declaration: ParsedFunction): FunctionSlotRecord => {
    const origin = findOrigin(scriptName, declaration);
    const id = functionSlotId(origin, declaration.name, declaration.signature);
    const existing = slotById.get(id);
    if (existing) {
      return existing;
    }

    const originDeclaration = firstDeclarationFor(scriptByName.get(origin), declaration.name, declaration.signature) ?? declaration;
    const slot: FunctionSlotRecord = withOverride(
      {
        id,
        name: declaration.name,
        signature: declaration.signature,
        returnType: originDeclaration.returnType,
        returnTypeCode: originDeclaration.returnTypeCode,
        params: parameterShapes(originDeclaration),
        originScript: origin,
        forwardIds: [],
        definitionIds: []
      },
      overrides.symbols[id]
    );
    slotById.set(id, slot);
    return slot;
  };

  for (const script of parsed) {
    for (const member of script.members) {
      const id = memberId(script.name, member.name);
      memberRecords.set(
        id,
        withOverride(
          {
            id,
            script: script.name,
            name: member.name,
            type: member.type,
            typeCode: member.typeCode,
            location: member.location,
            inheritedBy: []
          },
          overrides.symbols[id]
        )
      );
    }
  }

  for (const script of parsed) {
    for (const forward of script.forwards) {
      const slot = ensureSlot(script.name, forward);
      const id = functionForwardId(script.name, forward.name, forward.signature);
      const record = withOverride(
        {
          id,
          slotId: slot.id,
          script: script.name,
          name: forward.name,
          signature: forward.signature,
          returnType: forward.returnType,
          returnTypeCode: forward.returnTypeCode,
          params: parameterShapes(forward),
          location: forward.location
        },
        overrides.symbols[id] ?? symbolView(slot)
      );
      forwardRecords.set(id, record);
      pushUnique(slot.forwardIds, id);
    }

    for (const fn of script.functions) {
      const slot = ensureSlot(script.name, fn);
      const id = functionDefId(script.name, fn.name, fn.signature);
      const record = withOverride(
        {
          id,
          slotId: slot.id,
          script: script.name,
          name: fn.name,
          signature: fn.signature,
          returnType: fn.returnType,
          returnTypeCode: fn.returnTypeCode,
          params: parameterShapes(fn),
          location: fn.location,
          bodyRange: fn.bodyRange,
          overriddenBy: []
        },
        overrides.symbols[id] ?? symbolView(slot)
      );
      functionRecords.set(id, record);
      pushUnique(slot.definitionIds, id);

      const params = fn.params
        .map((param, ordinal) => {
          if (!param.name || !param.location) {
            return undefined;
          }
          const paramId = parameterId(script.name, id, param.name, ordinal);
          return withOverride(
            {
              id: paramId,
              containerId: id,
              script: script.name,
              name: param.name,
              type: param.type,
              typeCode: param.typeCode,
              ordinal,
              location: param.location
            },
            overrides.symbols[paramId]
          );
        })
        .filter((value): value is ParameterRecord => value !== undefined);

      const locals = fn.locals.map((local, ordinal) =>
        withOverride(
          {
            id: localId(script.name, id, local.name, local.location.range.start.line, local.location.range.start.character),
            containerId: id,
            script: script.name,
            name: local.name,
            type: local.type,
            typeCode: local.typeCode,
            ordinal,
            location: local.location
          },
          overrides.symbols[localId(script.name, id, local.name, local.location.range.start.line, local.location.range.start.character)]
        )
      );
      paramRecords.push(...params);
      localRecords.push(...locals);
      containerScopes.set(id, { script: script.name, containerId: id, params, locals });
    }

    for (const trigger of script.triggers) {
      const id = triggerId(script.name, trigger.event, trigger.location.range.start.line, trigger.location.range.start.character);
      const triggerRecord: TriggerRecord = {
        id,
        script: script.name,
        event: trigger.event,
        filter: trigger.filter,
        location: trigger.location,
        bodyRange: trigger.bodyRange
      };
      triggerRecords.push(triggerRecord);

      const locals = trigger.locals.map((local, ordinal) =>
        withOverride(
          {
            id: localId(script.name, id, local.name, local.location.range.start.line, local.location.range.start.character),
            containerId: id,
            script: script.name,
            name: local.name,
            type: local.type,
            typeCode: local.typeCode,
            ordinal,
            location: local.location
          },
          overrides.symbols[localId(script.name, id, local.name, local.location.range.start.line, local.location.range.start.character)]
        )
      );
      localRecords.push(...locals);
      containerScopes.set(id, { script: script.name, containerId: id, params: [], locals });
    }
  }

  const defByScriptKey = new Map<string, string>();
  const allDeclKeys = new Set<string>();
  for (const record of functionRecords.values()) {
    defByScriptKey.set(`${record.script}:${record.name}:${record.signature}`, record.id);
    allDeclKeys.add(`${record.name}:${record.signature}`);
  }
  for (const record of forwardRecords.values()) {
    allDeclKeys.add(`${record.name}:${record.signature}`);
  }

  const effectiveDefinitionBySlotAndScript = new Map<string, Map<string, string>>();
  for (const slot of slotById.values()) {
    const key = `${slot.name}:${slot.signature}`;
    for (const script of parsed) {
      const chain = ancestorChain(script.name);
      if (!chain.includes(slot.originScript)) {
        continue;
      }
      let effective: string | undefined;
      for (const ancestor of [...chain].reverse()) {
        const candidate = defByScriptKey.get(`${ancestor}:${key}`);
        if (candidate) {
          effective = candidate;
          break;
        }
      }
      if (effective) {
        if (!effectiveDefinitionBySlotAndScript.has(slot.id)) {
          effectiveDefinitionBySlotAndScript.set(slot.id, new Map());
        }
        effectiveDefinitionBySlotAndScript.get(slot.id)?.set(script.name, effective);
      }
    }
  }

  for (const record of functionRecords.values()) {
    const chain = ancestorChain(record.script);
    const earlier = chain.slice(0, -1).reverse();
    for (const ancestor of earlier) {
      const candidate = defByScriptKey.get(`${ancestor}:${record.name}:${record.signature}`);
      if (candidate) {
        record.overrides = candidate;
        const parent = functionRecords.get(candidate);
        parent?.overriddenBy.push(record.id);
        break;
      }
    }
  }

  const effectiveMemberByScript = new Map<string, Map<string, string>>();
  for (const script of parsed) {
    const members = new Map<string, string>();
    for (const ancestor of ancestorChain(script.name)) {
      const ancestorScript = scriptByName.get(ancestor);
      if (!ancestorScript) {
        continue;
      }
      for (const member of ancestorScript.members) {
        if (members.has(member.name)) {
          diagnostics.push({
            severity: "warning",
            script: script.name,
            message: `Member '${member.name}' is redeclared through inheritance in '${script.name}'.`,
            location: member.location
          });
          continue;
        }
        members.set(member.name, memberId(ancestor, member.name));
      }
    }
    effectiveMemberByScript.set(script.name, members);
  }

  for (const member of memberRecords.values()) {
    for (const script of parsed) {
      if (script.name !== member.script && effectiveMemberByScript.get(script.name)?.get(member.name) === member.id) {
        member.inheritedBy.push(script.name);
      }
    }
    member.inheritedBy.sort();
  }

  const functionNameByScript = new Map<string, Map<string, string>>();
  for (const script of parsed) {
    const byName = new Map<string, string>();
    const signaturesByName = new Map<string, Set<string>>();
    for (const ancestor of ancestorChain(script.name)) {
      const byAncestorName = declarationsByScriptAndName.get(ancestor);
      if (!byAncestorName) {
        continue;
      }
      for (const [name, signatures] of byAncestorName) {
        if (!signaturesByName.has(name)) {
          signaturesByName.set(name, new Set());
        }
        for (const signature of signatures) {
          signaturesByName.get(name)?.add(signature);
        }
        if (!byName.has(name)) {
          const signature = [...signatures].sort()[0];
          if (signature) {
            const decl = firstDeclarationFor(scriptByName.get(ancestor), name, signature);
            if (decl) {
              byName.set(name, ensureSlot(ancestor, decl).id);
            }
          }
        }
      }
    }
    for (const [name, signatures] of signaturesByName) {
      if (signatures.size > 1) {
        diagnostics.push({
          severity: "warning",
          script: script.name,
          message: `Function name '${name}' has multiple signatures visible in '${script.name}'.`
        });
      }
    }
    functionNameByScript.set(script.name, byName);
  }

  const references: ReferenceRecord[] = [];
  for (const script of parsed) {
    for (const fn of script.functions) {
      const containerId = functionDefId(script.name, fn.name, fn.signature);
      for (const ref of fn.references) {
        const resolved = resolveReference(
          script.name,
          containerId,
          ref.name,
          containerScopes,
          effectiveMemberByScript,
          functionNameByScript,
          effectiveDefinitionBySlotAndScript
        );
        if (!resolved && !looksInteresting(ref.name)) {
          continue;
        }
        references.push({
          id: referenceId(script.name, containerId, ref.name, ref.location.range.start.line, ref.location.range.start.character),
          script: script.name,
          containerId,
          name: ref.name,
          location: ref.location,
          ...resolved
        });
      }
    }

    for (const trigger of script.triggers) {
      const containerId = triggerId(script.name, trigger.event, trigger.location.range.start.line, trigger.location.range.start.character);
      for (const ref of trigger.references) {
        const resolved = resolveReference(
          script.name,
          containerId,
          ref.name,
          containerScopes,
          effectiveMemberByScript,
          functionNameByScript,
          effectiveDefinitionBySlotAndScript
        );
        if (!resolved && !looksInteresting(ref.name)) {
          continue;
        }
        references.push({
          id: referenceId(script.name, containerId, ref.name, ref.location.range.start.line, ref.location.range.start.character),
          script: script.name,
          containerId,
          name: ref.name,
          location: ref.location,
          ...resolved
        });
      }
    }
  }

  const scripts: ScriptRecord[] = parsed.map((script) => {
    const declaredSlots = [...script.forwards, ...script.functions].map((fn) => ensureSlot(script.name, fn).id);

    return {
      id: script.name,
      name: script.name,
      path: script.path,
      parent: script.parent,
      location: script.location,
      memberIds: script.members.map((member) => memberId(script.name, member.name)).sort(),
      functionSlotIds: [...new Set(declaredSlots)].sort(),
      functionDefinitionIds: script.functions.map((fn) => functionDefId(script.name, fn.name, fn.signature)).sort(),
      functionForwardIds: script.forwards.map((fn) => functionForwardId(script.name, fn.name, fn.signature)).sort(),
      triggerIds: triggerRecords
        .filter((trigger) => trigger.script === script.name)
        .map((trigger) => trigger.id)
        .sort()
    };
  });

  const functions = [...functionRecords.values()].sort(byId);
  const forwards = [...forwardRecords.values()].sort(byId);
  const functionSlots = [...slotById.values()].sort(byId).map((slot) => ({
    ...slot,
    definitionIds: [...slot.definitionIds].sort(),
    forwardIds: [...slot.forwardIds].sort()
  }));
  const members = [...memberRecords.values()].sort(byId);
  const triggers = triggerRecords.sort(byId);
  const params = paramRecords.sort(byId);
  const locals = localRecords.sort(byId);
  const sortedReferences = references.sort(byId);
  const sortedDiagnostics = diagnostics.sort((a, b) => {
    const scriptCmp = (a.script ?? "").localeCompare(b.script ?? "");
    if (scriptCmp !== 0) {
      return scriptCmp;
    }
    return a.message.localeCompare(b.message);
  });

  return {
    schemaVersion: SYMBOL_SCHEMA_VERSION,
    sourceRoot: normalizePath(sourceRoot),
    counts: {
      scripts: scripts.length,
      members: members.length,
      functionSlots: functionSlots.length,
      functionDefinitions: functions.length,
      functionForwards: forwards.length,
      triggers: triggers.length,
      params: params.length,
      locals: locals.length,
      references: sortedReferences.length,
      resolvedReferences: sortedReferences.filter((ref) => ref.targetId).length,
      diagnostics: sortedDiagnostics.length
    },
    scripts,
    inheritance: sortRecord(inheritance),
    members,
    functionSlots,
    functions,
    forwards,
    triggers,
    params,
    locals,
    references: sortedReferences,
    diagnostics: sortedDiagnostics
  };
}

export function writeSymbolIndex(outPath: string, index: SymbolIndex): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function symbolReport(index: SymbolIndex): string {
  const lines = [
    "# Wombat Symbol Report",
    "",
    `Source root: ${index.sourceRoot}`,
    `Scripts: ${index.counts.scripts}`,
    `Function slots: ${index.counts.functionSlots}`,
    `Function definitions: ${index.counts.functionDefinitions}`,
    `Members: ${index.counts.members}`,
    `References: ${index.counts.resolvedReferences}/${index.counts.references} resolved`,
    `Diagnostics: ${index.counts.diagnostics}`,
    ""
  ];

  if (index.diagnostics.length > 0) {
    lines.push("## Diagnostics", "");
    for (const diagnostic of index.diagnostics.slice(0, 200)) {
      const where = diagnostic.script ? ` (${diagnostic.script})` : "";
      lines.push(`- ${diagnostic.severity}${where}: ${diagnostic.message}`);
    }
    if (index.diagnostics.length > 200) {
      lines.push(`- ... ${index.diagnostics.length - 200} more`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function resolveReference(
  script: string,
  containerId: string,
  name: string,
  containerScopes: Map<string, ContainerScope>,
  effectiveMemberByScript: Map<string, Map<string, string>>,
  functionNameByScript: Map<string, Map<string, string>>,
  effectiveDefinitionBySlotAndScript: Map<string, Map<string, string>>
): Pick<ReferenceRecord, "targetId" | "definitionTargetId" | "targetKind"> | undefined {
  const scope = containerScopes.get(containerId);
  const param = scope?.params.find((candidate) => candidate.name === name);
  if (param) {
    return { targetId: param.id, definitionTargetId: param.id, targetKind: "param" };
  }
  const local = scope?.locals.find((candidate) => candidate.name === name);
  if (local) {
    return { targetId: local.id, definitionTargetId: local.id, targetKind: "local" };
  }
  const memberIdForName = effectiveMemberByScript.get(script)?.get(name);
  if (memberIdForName) {
    return { targetId: memberIdForName, definitionTargetId: memberIdForName, targetKind: "member" };
  }
  const slotIdForName = functionNameByScript.get(script)?.get(name);
  if (slotIdForName) {
    return {
      targetId: slotIdForName,
      definitionTargetId: effectiveDefinitionBySlotAndScript.get(slotIdForName)?.get(script) ?? slotIdForName,
      targetKind: "function"
    };
  }
  return undefined;
}

function firstDeclarationFor(script: ParsedScript | undefined, name: string, signature: string): ParsedFunction | undefined {
  return [...(script?.forwards ?? []), ...(script?.functions ?? [])].find(
    (declaration) => declaration.name === name && declaration.signature === signature
  );
}

function parameterShapes(declaration: ParsedFunction): FunctionParameterShape[] {
  return declaration.params.map((param) => ({
    name: param.name,
    type: param.type,
    typeCode: param.typeCode,
    location: param.location
  }));
}

function withOverride<T extends object>(record: T, override: SymbolOverride | undefined): T {
  if (!override) {
    return record;
  }
  const decorated = { ...record } as T & { displayName?: string; notes?: string };
  decorated.displayName = override.displayName ?? decorated.displayName;
  decorated.notes = override.notes ?? decorated.notes;
  return decorated;
}

function symbolView(record: { displayName?: string; notes?: string }): SymbolOverride | undefined {
  if (!record.displayName && !record.notes) {
    return undefined;
  }
  return {
    displayName: record.displayName,
    notes: record.notes
  };
}

function functionKey(declaration: ParsedFunction): string {
  return `${declaration.name}:${declaration.signature}`;
}

function functionSlotId(originScript: string, name: string, signature: string): string {
  return `function-slot:${originScript}:${name}:${signature}`;
}

function functionDefId(script: string, name: string, signature: string): string {
  return `function-def:${script}:${name}:${signature}`;
}

function functionForwardId(script: string, name: string, signature: string): string {
  return `function-forward:${script}:${name}:${signature}`;
}

function memberId(script: string, name: string): string {
  return `member:${script}:${name}`;
}

function parameterId(script: string, containerId: string, name: string, ordinal: number): string {
  return `param:${script}:${safeId(containerId)}:${name}:${ordinal}`;
}

function localId(script: string, containerId: string, name: string, line: number, character: number): string {
  return `local:${script}:${safeId(containerId)}:${name}:${line}_${character}`;
}

function triggerId(script: string, event: string, line: number, character: number): string {
  return `trigger:${script}:${event}:${line}_${character}`;
}

function referenceId(script: string, containerId: string, name: string, line: number, character: number): string {
  return `reference:${script}:${safeId(containerId)}:${name}:${line}_${character}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function looksInteresting(name: string): boolean {
  return /^Q[0-9A-Z]{3}$/.test(name);
}

function pushMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
