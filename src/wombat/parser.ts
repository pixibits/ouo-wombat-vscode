import { tokenize, type Token } from "./tokenizer";
import {
  TYPE_CODES,
  TYPE_NAMES,
  type DiagnosticRecord,
  type SourceFile,
  type SourceLocation,
  type SourceRange,
  type WombatType
} from "./types";

export interface ParsedParam {
  name?: string;
  type: WombatType;
  typeCode: string;
  location?: SourceLocation;
}

export interface ParsedLocal {
  name: string;
  type: WombatType;
  typeCode: string;
  location: SourceLocation;
}

export interface ParsedReference {
  name: string;
  location: SourceLocation;
}

export interface ParsedMember {
  name: string;
  type: WombatType;
  typeCode: string;
  location: SourceLocation;
}

export interface ParsedFunction {
  kind: "function" | "forward";
  name: string;
  returnType: WombatType;
  returnTypeCode: string;
  signature: string;
  params: ParsedParam[];
  location: SourceLocation;
  bodyRange?: SourceRange;
  bodyMembers: ParsedMember[];
  locals: ParsedLocal[];
  references: ParsedReference[];
}

export interface ParsedTrigger {
  event: string;
  filter?: string;
  location: SourceLocation;
  bodyRange?: SourceRange;
  bodyMembers: ParsedMember[];
  locals: ParsedLocal[];
  references: ParsedReference[];
}

export interface ParsedScript {
  name: string;
  path: string;
  location: SourceLocation;
  parent?: string;
  parentLocation?: SourceLocation;
  members: ParsedMember[];
  forwards: ParsedFunction[];
  functions: ParsedFunction[];
  triggers: ParsedTrigger[];
  diagnostics: DiagnosticRecord[];
}

const statementKeywords = new Set([
  "function",
  "forward",
  "member",
  "trigger",
  "inherits",
  "if",
  "else",
  "while",
  "for",
  "switch",
  "case",
  "default",
  "return",
  "goto",
  "break",
  "continue"
]);

export function parseSourceFile(file: SourceFile): ParsedScript {
  const { tokens, diagnostics } = tokenize(file.text, file.path);
  const cursor = new Cursor(tokens);
  const script: ParsedScript = {
    name: file.name,
    path: file.path,
    location: {
      path: file.path,
      range: {
        start: { line: 0, character: 0, offset: 0 },
        end: positionAtEnd(file.text)
      }
    },
    members: [],
    forwards: [],
    functions: [],
    triggers: [],
    diagnostics
  };

  while (!cursor.isEof()) {
    if (cursor.matchIdentifier("inherits")) {
      parseInherits(cursor, script);
    } else if (cursor.matchIdentifier("member")) {
      const member = parseMember(cursor, script.path);
      if (member) {
        script.members.push(member);
      }
    } else if (cursor.matchIdentifier("forward")) {
      const forward = parseFunctionLike(cursor, script.path, "forward");
      if (forward) {
        script.forwards.push(forward);
      }
    } else if (cursor.matchIdentifier("function")) {
      const fn = parseFunctionLike(cursor, script.path, "function");
      if (fn) {
        script.members.push(...fn.bodyMembers);
        script.functions.push(fn);
      }
    } else if (cursor.matchIdentifier("trigger")) {
      const trigger = parseTrigger(cursor, script.path);
      if (trigger) {
        script.members.push(...trigger.bodyMembers);
        script.triggers.push(trigger);
      }
    } else {
      cursor.advance();
    }
  }

  return script;
}

function parseInherits(cursor: Cursor, script: ParsedScript): void {
  const parent = cursor.consumeIdentifier();
  if (parent) {
    script.parent = parent.text;
    script.parentLocation = tokenLocation(script.path, parent);
  }
  cursor.consumeUntil(";");
}

function parseMember(cursor: Cursor, scriptPath: string): ParsedMember | undefined {
  const typeToken = cursor.consume();
  const nameToken = cursor.consumeIdentifier();
  cursor.consumeUntil(";");

  if (!typeToken || !nameToken || !isTypeName(typeToken.text)) {
    return undefined;
  }

  const type = typeToken.text as WombatType;
  return {
    name: nameToken.text,
    type,
    typeCode: TYPE_CODES[type],
    location: tokenLocation(scriptPath, nameToken)
  };
}

function parseFunctionLike(cursor: Cursor, scriptPath: string, kind: "function" | "forward"): ParsedFunction | undefined {
  const returnToken = cursor.consume();
  const nameToken = cursor.consumeIdentifier();
  if (!returnToken || !nameToken || !isTypeName(returnToken.text)) {
    cursor.consumeUntil(kind === "forward" ? ";" : "{");
    return undefined;
  }

  const params = parseParamList(cursor, scriptPath);
  const returnType = returnToken.text as WombatType;
  const signature = TYPE_CODES[returnType] + params.map((p) => p.typeCode).join("");
  const location = tokenLocation(scriptPath, nameToken);

  if (kind === "forward") {
    cursor.consumeUntil(";");
    return {
      kind,
      name: nameToken.text,
      returnType,
      returnTypeCode: TYPE_CODES[returnType],
      signature,
      params,
      location,
      bodyMembers: [],
      locals: [],
      references: []
    };
  }

  const body = parseBody(cursor);
  const scan = scanBody(scriptPath, body.tokens);

  return {
    kind,
    name: nameToken.text,
    returnType,
    returnTypeCode: TYPE_CODES[returnType],
    signature,
    params,
    location,
    bodyRange: body.range,
    bodyMembers: scan.members,
    locals: scan.locals,
    references: scan.references
  };
}

function parseTrigger(cursor: Cursor, scriptPath: string): ParsedTrigger | undefined {
  const eventToken = cursor.consumeIdentifier();
  if (!eventToken) {
    cursor.consumeUntil("{");
    return undefined;
  }

  let filter: string | undefined;
  if (cursor.checkText("(")) {
    const filterParts: string[] = [];
    cursor.advance();
    let depth = 1;
    while (!cursor.isEof() && depth > 0) {
      const token = cursor.consume();
      if (!token) {
        break;
      }
      if (token.text === "(") {
        depth++;
      } else if (token.text === ")") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      filterParts.push(token.raw || token.text);
    }
    filter = filterParts.join("");
  }

  const body = parseBody(cursor);
  const scan = scanBody(scriptPath, body.tokens);
  return {
    event: eventToken.text,
    filter,
    location: tokenLocation(scriptPath, eventToken),
    bodyRange: body.range,
    bodyMembers: scan.members,
    locals: scan.locals,
    references: scan.references
  };
}

function parseParamList(cursor: Cursor, scriptPath: string): ParsedParam[] {
  const params: ParsedParam[] = [];
  if (!cursor.checkText("(")) {
    return params;
  }

  cursor.advance();
  while (!cursor.isEof() && !cursor.checkText(")")) {
    const typeToken = cursor.consume();
    if (!typeToken) {
      break;
    }
    if (typeToken.text === ",") {
      continue;
    }
    if (!isTypeName(typeToken.text)) {
      cursor.advance();
      continue;
    }

    const type = typeToken.text as WombatType;
    let nameToken: Token | undefined;
    if (cursor.peek()?.type === "identifier") {
      nameToken = cursor.consumeIdentifier();
    }

    params.push({
      name: nameToken?.text,
      type,
      typeCode: TYPE_CODES[type],
      location: nameToken ? tokenLocation(scriptPath, nameToken) : undefined
    });

    if (cursor.checkText(",")) {
      cursor.advance();
    }
  }

  if (cursor.checkText(")")) {
    cursor.advance();
  }
  return params;
}

function parseBody(cursor: Cursor): { tokens: Token[]; range?: SourceRange } {
  if (!cursor.checkText("{")) {
    return { tokens: [] };
  }

  const open = cursor.consume();
  const bodyStart = cursor.position;
  let depth = 1;
  let close: Token | undefined;

  while (!cursor.isEof() && depth > 0) {
    const token = cursor.consume();
    if (!token) {
      break;
    }
    if (token.text === "{") {
      depth++;
    } else if (token.text === "}") {
      depth--;
      if (depth === 0) {
        close = token;
        break;
      }
    }
  }

  const bodyEnd = close ? cursor.position - 1 : cursor.position;
  const tokens = cursor.tokens.slice(bodyStart, Math.max(bodyStart, bodyEnd));
  return {
    tokens,
    range:
      open && close
        ? {
            start: open.range.start,
            end: close.range.end
          }
        : undefined
  };
}

function scanBody(scriptPath: string, bodyTokens: Token[]): { members: ParsedMember[]; locals: ParsedLocal[]; references: ParsedReference[] } {
  const members: ParsedMember[] = [];
  const locals: ParsedLocal[] = [];
  const declarationIndexes = new Set<number>();

  for (let i = 0; i < bodyTokens.length - 1; i++) {
    const token = bodyTokens[i];
    const next = bodyTokens[i + 1];

    if (token?.text === "member") {
      const typeToken = bodyTokens[i + 1];
      const nameToken = bodyTokens[i + 2];
      if (typeToken && nameToken && isTypeName(typeToken.text) && nameToken.type === "identifier") {
        const type = typeToken.text as WombatType;
        declarationIndexes.add(nameToken.index);
        members.push({
          name: nameToken.text,
          type,
          typeCode: TYPE_CODES[type],
          location: tokenLocation(scriptPath, nameToken)
        });
        i += 2;
      }
      continue;
    }

    if (token && next && isTypeName(token.text) && next.type === "identifier") {
      const previous = bodyTokens[i - 1];
      if (previous?.text === "member") {
        continue;
      }
      const type = token.text as WombatType;
      declarationIndexes.add(next.index);
      locals.push({
        name: next.text,
        type,
        typeCode: TYPE_CODES[type],
        location: tokenLocation(scriptPath, next)
      });
    }
  }

  const references: ParsedReference[] = [];
  for (const token of bodyTokens) {
    if (token.type !== "identifier") {
      continue;
    }
    if (declarationIndexes.has(token.index)) {
      continue;
    }
    if (isKeyword(token.text)) {
      continue;
    }
    references.push({
      name: token.text,
      location: tokenLocation(scriptPath, token)
    });
  }

  return { members, locals, references };
}

function isTypeName(value: string): value is WombatType {
  return TYPE_NAMES.has(value as WombatType);
}

function isKeyword(value: string): boolean {
  return statementKeywords.has(value) || isTypeName(value);
}

function tokenLocation(path: string, token: Token): SourceLocation {
  return {
    path,
    range: token.range
  };
}

function positionAtEnd(text: string): SourceRange["end"] {
  let line = 0;
  let character = 0;
  for (const ch of text) {
    if (ch === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character, offset: text.length };
}

class Cursor {
  position = 0;

  constructor(readonly tokens: Token[]) {}

  isEof(): boolean {
    return this.peek()?.type === "eof" || this.position >= this.tokens.length;
  }

  peek(): Token | undefined {
    return this.tokens[this.position];
  }

  checkText(text: string): boolean {
    return this.peek()?.text === text;
  }

  matchIdentifier(text: string): boolean {
    if (this.peek()?.type === "identifier" && this.peek()?.text === text) {
      this.position++;
      return true;
    }
    return false;
  }

  consumeIdentifier(): Token | undefined {
    const token = this.peek();
    if (token?.type === "identifier") {
      this.position++;
      return token;
    }
    return undefined;
  }

  consume(): Token | undefined {
    if (this.isEof()) {
      return undefined;
    }
    return this.tokens[this.position++];
  }

  advance(): void {
    if (!this.isEof()) {
      this.position++;
    }
  }

  consumeUntil(text: string): void {
    while (!this.isEof() && this.peek()?.text !== text) {
      this.position++;
    }
    if (this.peek()?.text === text) {
      this.position++;
    }
  }
}
