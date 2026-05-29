import type {
  FunctionDefinitionRecord,
  FunctionForwardRecord,
  FunctionSlotRecord,
  LocalRecord,
  MemberRecord,
  ParameterRecord,
  ReferenceRecord,
  SourceRange,
  SymbolIndex,
  TriggerRecord
} from "../wombat/types";

export interface TextPosition {
  line: number;
  character: number;
}

export type SymbolEntity =
  | { kind: "function-slot"; record: FunctionSlotRecord }
  | { kind: "function-def"; record: FunctionDefinitionRecord }
  | { kind: "function-forward"; record: FunctionForwardRecord }
  | { kind: "member"; record: MemberRecord }
  | { kind: "param"; record: ParameterRecord }
  | { kind: "local"; record: LocalRecord }
  | { kind: "trigger"; record: TriggerRecord }
  | { kind: "reference"; record: ReferenceRecord };

export interface SymbolLookup {
  entity: SymbolEntity;
  target?: SymbolEntity;
  definitionTarget?: SymbolEntity;
}

export interface IndexModel {
  index: SymbolIndex;
  byId: Map<string, SymbolEntity>;
  declarationsByPath: Map<string, SymbolEntity[]>;
  referencesByPath: Map<string, ReferenceRecord[]>;
}

export function createIndexModel(index: SymbolIndex): IndexModel {
  const byId = new Map<string, SymbolEntity>();
  const declarationsByPath = new Map<string, SymbolEntity[]>();
  const referencesByPath = new Map<string, ReferenceRecord[]>();

  for (const record of index.functionSlots) {
    byId.set(record.id, { kind: "function-slot", record });
  }
  for (const record of index.functions) {
    const entity: SymbolEntity = { kind: "function-def", record };
    byId.set(record.id, entity);
    pushMapArray(declarationsByPath, record.location.path, entity);
  }
  for (const record of index.forwards) {
    const entity: SymbolEntity = { kind: "function-forward", record };
    byId.set(record.id, entity);
    pushMapArray(declarationsByPath, record.location.path, entity);
  }
  for (const record of index.members) {
    const entity: SymbolEntity = { kind: "member", record };
    byId.set(record.id, entity);
    pushMapArray(declarationsByPath, record.location.path, entity);
  }
  for (const record of index.params) {
    const entity: SymbolEntity = { kind: "param", record };
    byId.set(record.id, entity);
    pushMapArray(declarationsByPath, record.location.path, entity);
  }
  for (const record of index.locals) {
    const entity: SymbolEntity = { kind: "local", record };
    byId.set(record.id, entity);
    pushMapArray(declarationsByPath, record.location.path, entity);
  }
  for (const record of index.triggers) {
    const entity: SymbolEntity = { kind: "trigger", record };
    byId.set(record.id, entity);
    pushMapArray(declarationsByPath, record.location.path, entity);
  }
  for (const record of index.references) {
    pushMapArray(referencesByPath, record.location.path, record);
  }

  for (const entities of declarationsByPath.values()) {
    entities.sort((a, b) => rangeStart(entityRange(a)).line - rangeStart(entityRange(b)).line);
  }

  return { index, byId, declarationsByPath, referencesByPath };
}

export function findSymbolAt(model: IndexModel, relativePath: string, position: TextPosition): SymbolLookup | undefined {
  for (const entity of model.declarationsByPath.get(relativePath) ?? []) {
    if (contains(entityRange(entity), position)) {
      return {
        entity,
        target: entity.kind === "function-def" || entity.kind === "function-forward" ? model.byId.get(entity.record.slotId) : entity,
        definitionTarget: entity
      };
    }
  }

  for (const ref of model.referencesByPath.get(relativePath) ?? []) {
    if (contains(ref.location.range, position)) {
      const entity: SymbolEntity = { kind: "reference", record: ref };
      return {
        entity,
        target: ref.targetId ? model.byId.get(ref.targetId) : undefined,
        definitionTarget: ref.definitionTargetId ? model.byId.get(ref.definitionTargetId) : undefined
      };
    }
  }

  return undefined;
}

export function formatHover(lookup: SymbolLookup): string {
  const target = lookup.target ?? lookup.entity;
  const definition = lookup.definitionTarget;
  const lines: string[] = [];

  lines.push(`**${displayName(target)}**`);
  lines.push("");
  lines.push(`Kind: ${kindLabel(target)}`);

  const signature = signatureOf(target);
  if (signature) {
    lines.push(`Signature: \`${signature}\``);
  }

  const location = locationOf(definition ?? target);
  if (location) {
    lines.push(`Definition: \`${location.path}:${location.range.start.line + 1}\``);
  }

  const slot = slotOf(target);
  if (slot) {
    lines.push(`Slot: \`${slot.id}\``);
    lines.push(`Origin: \`${slot.originScript}\``);
  }

  const notes = notesOf(target);
  if (notes) {
    lines.push("");
    lines.push(notes);
  }

  return lines.join("\n");
}

export function codeLensTitle(entity: SymbolEntity, model: IndexModel): string | undefined {
  if (entity.kind === "function-def") {
    const slot = model.byId.get(entity.record.slotId);
    const label = displayName(slot ?? entity);
    const parts = label === entity.record.name ? [`${entity.record.name} · ${entity.record.signature}`] : [`${entity.record.name} -> ${label}`];
    if (entity.record.overrides) {
      parts.push(`overrides ${shortId(entity.record.overrides)}`);
    }
    if (entity.record.overriddenBy.length > 0) {
      parts.push(`${entity.record.overriddenBy.length} override(s)`);
    }
    return parts.join(" · ");
  }

  if (entity.kind === "function-forward") {
    const slot = model.byId.get(entity.record.slotId);
    const label = displayName(slot ?? entity);
    return label === entity.record.name
      ? `${entity.record.name} · forward ${entity.record.signature}`
      : `${entity.record.name} -> ${label} · forward`;
  }

  if (entity.kind === "member") {
    const label = displayName(entity);
    return label === entity.record.name ? undefined : `${entity.record.name} -> ${label}`;
  }

  return undefined;
}

export function allReferencesFor(model: IndexModel, lookup: SymbolLookup): SymbolEntity[] {
  const targetId = lookup.target && "id" in lookup.target.record ? lookup.target.record.id : undefined;
  if (!targetId) {
    return [lookup.entity];
  }

  const results: SymbolEntity[] = [];
  const target = model.byId.get(targetId);
  if (target) {
    if (target.kind === "function-slot") {
      for (const id of target.record.definitionIds) {
        const entity = model.byId.get(id);
        if (entity) {
          results.push(entity);
        }
      }
      for (const id of target.record.forwardIds) {
        const entity = model.byId.get(id);
        if (entity) {
          results.push(entity);
        }
      }
    } else {
      results.push(target);
    }
  }

  for (const ref of model.index.references) {
    if (ref.targetId === targetId) {
      results.push({ kind: "reference", record: ref });
    }
  }
  return results;
}

export function entityRange(entity: SymbolEntity): SourceRange {
  const location = locationOf(entity);
  if (!location) {
    throw new Error(`Entity ${entity.kind} has no source range.`);
  }
  return location.range;
}

export function locationOf(entity: SymbolEntity | undefined): { path: string; range: SourceRange } | undefined {
  if (!entity) {
    return undefined;
  }
  if (entity.kind === "function-slot") {
    return undefined;
  }
  return entity.record.location;
}

function displayName(entity: SymbolEntity): string {
  if (entity.kind === "reference") {
    return entity.record.name;
  }
  if (entity.kind === "trigger") {
    return `trigger ${entity.record.event}`;
  }
  return entity.record.displayName ?? entity.record.name;
}

function notesOf(entity: SymbolEntity): string | undefined {
  if (entity.kind === "reference" || entity.kind === "trigger") {
    return undefined;
  }
  return entity.record.notes;
}

function signatureOf(entity: SymbolEntity): string | undefined {
  if (entity.kind === "function-slot" || entity.kind === "function-def" || entity.kind === "function-forward") {
    return entity.record.signature;
  }
  if (entity.kind === "member" || entity.kind === "param" || entity.kind === "local") {
    return entity.record.type;
  }
  return undefined;
}

function slotOf(entity: SymbolEntity): FunctionSlotRecord | undefined {
  return entity.kind === "function-slot" ? entity.record : undefined;
}

function kindLabel(entity: SymbolEntity): string {
  switch (entity.kind) {
    case "function-slot":
      return "function slot";
    case "function-def":
      return "function definition";
    case "function-forward":
      return "forward declaration";
    case "member":
      return "member";
    case "param":
      return "parameter";
    case "local":
      return "local";
    case "trigger":
      return "trigger";
    case "reference":
      return "reference";
  }
}

function contains(range: SourceRange, position: TextPosition): boolean {
  const startsBefore =
    range.start.line < position.line || (range.start.line === position.line && range.start.character <= position.character);
  const endsAfter = range.end.line > position.line || (range.end.line === position.line && range.end.character >= position.character);
  return startsBefore && endsAfter;
}

function rangeStart(range: SourceRange): TextPosition {
  return range.start;
}

function pushMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

function shortId(id: string): string {
  return id.replace(/^function-def:/, "").replace(/:/g, ".");
}
