export const SYMBOL_SCHEMA_VERSION = 1;

export type WombatType = "int" | "string" | "ustring" | "loc" | "obj" | "list" | "void" | "unknown";

export interface SourcePosition {
  line: number;
  character: number;
  offset: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface SourceLocation {
  path: string;
  range: SourceRange;
}

export interface DiagnosticRecord {
  severity: "info" | "warning" | "error";
  message: string;
  script?: string;
  location?: SourceLocation;
}

export interface SymbolOverride {
  displayName?: string;
  notes?: string;
  tags?: string[];
}

export interface OverridesFile {
  schemaVersion: 1;
  symbols: Record<string, SymbolOverride>;
}

export interface ParameterRecord {
  id: string;
  containerId: string;
  script: string;
  name: string;
  type: WombatType;
  typeCode: string;
  ordinal: number;
  location: SourceLocation;
  displayName?: string;
  notes?: string;
}

export interface LocalRecord {
  id: string;
  containerId: string;
  script: string;
  name: string;
  type: WombatType;
  typeCode: string;
  ordinal: number;
  location: SourceLocation;
  displayName?: string;
  notes?: string;
}

export interface MemberRecord {
  id: string;
  script: string;
  name: string;
  type: WombatType;
  typeCode: string;
  location: SourceLocation;
  inheritedBy: string[];
  displayName?: string;
  notes?: string;
}

export interface FunctionParameterShape {
  name?: string;
  type: WombatType;
  typeCode: string;
  location?: SourceLocation;
}

export interface FunctionSlotRecord {
  id: string;
  name: string;
  signature: string;
  returnType: WombatType;
  returnTypeCode: string;
  params: FunctionParameterShape[];
  originScript: string;
  forwardIds: string[];
  definitionIds: string[];
  displayName?: string;
  notes?: string;
}

export interface FunctionDefinitionRecord {
  id: string;
  slotId: string;
  script: string;
  name: string;
  signature: string;
  returnType: WombatType;
  returnTypeCode: string;
  params: FunctionParameterShape[];
  location: SourceLocation;
  bodyRange?: SourceRange;
  overrides?: string;
  overriddenBy: string[];
  displayName?: string;
  notes?: string;
}

export interface FunctionForwardRecord {
  id: string;
  slotId: string;
  script: string;
  name: string;
  signature: string;
  returnType: WombatType;
  returnTypeCode: string;
  params: FunctionParameterShape[];
  location: SourceLocation;
  displayName?: string;
  notes?: string;
}

export interface TriggerRecord {
  id: string;
  script: string;
  event: string;
  filter?: string;
  location: SourceLocation;
  bodyRange?: SourceRange;
}

export interface ReferenceRecord {
  id: string;
  script: string;
  containerId: string;
  name: string;
  location: SourceLocation;
  targetId?: string;
  definitionTargetId?: string;
  targetKind?: "function" | "member" | "local" | "param";
}

export interface ScriptRecord {
  id: string;
  name: string;
  path: string;
  parent?: string;
  location: SourceLocation;
  memberIds: string[];
  functionSlotIds: string[];
  functionDefinitionIds: string[];
  functionForwardIds: string[];
  triggerIds: string[];
}

export interface SymbolIndex {
  schemaVersion: 1;
  sourceRoot: string;
  counts: {
    scripts: number;
    members: number;
    functionSlots: number;
    functionDefinitions: number;
    functionForwards: number;
    triggers: number;
    params: number;
    locals: number;
    references: number;
    resolvedReferences: number;
    diagnostics: number;
  };
  scripts: ScriptRecord[];
  inheritance: Record<string, string | null>;
  members: MemberRecord[];
  functionSlots: FunctionSlotRecord[];
  functions: FunctionDefinitionRecord[];
  forwards: FunctionForwardRecord[];
  triggers: TriggerRecord[];
  params: ParameterRecord[];
  locals: LocalRecord[];
  references: ReferenceRecord[];
  diagnostics: DiagnosticRecord[];
}

export interface SourceFile {
  path: string;
  name: string;
  text: string;
}

export const TYPE_CODES: Record<WombatType, string> = {
  int: "i",
  string: "s",
  ustring: "q",
  loc: "c",
  obj: "o",
  list: "l",
  void: "v",
  unknown: "u"
};

export const TYPE_NAMES = new Set<WombatType>([
  "int",
  "string",
  "ustring",
  "loc",
  "obj",
  "list",
  "void"
]);
