import type { DiagnosticRecord, SourcePosition, SourceRange } from "./types";

export type TokenType = "identifier" | "number" | "string" | "symbol" | "eof";

export interface Token {
  type: TokenType;
  text: string;
  raw: string;
  range: SourceRange;
  index: number;
}

interface ScannerState {
  offset: number;
  line: number;
  character: number;
}

const multiCharSymbols = new Set(["==", "!=", "<=", ">=", "&&", "||", "++", "--"]);
const singleCharSymbols = new Set("(){}[];,=+-*/%<>!^:");

export function tokenize(text: string, scriptPath = "<memory>"): { tokens: Token[]; diagnostics: DiagnosticRecord[] } {
  const scanner = new Scanner(text, scriptPath);
  return scanner.scan();
}

class Scanner {
  private state: ScannerState = { offset: 0, line: 0, character: 0 };
  private readonly tokens: Token[] = [];
  private readonly diagnostics: DiagnosticRecord[] = [];

  constructor(
    private readonly text: string,
    private readonly scriptPath: string
  ) {}

  scan(): { tokens: Token[]; diagnostics: DiagnosticRecord[] } {
    while (!this.isAtEnd()) {
      this.skipTrivia();
      if (this.isAtEnd()) {
        break;
      }

      const start = this.position();
      const ch = this.peek();

      if (ch === "\"") {
        this.scanString(start);
      } else if (isIdentifierStart(ch)) {
        this.scanIdentifier(start);
      } else if (isDigit(ch)) {
        this.scanNumber(start);
      } else {
        this.scanSymbol(start);
      }
    }

    const eof = this.position();
    this.push("eof", "", "", { start: eof, end: eof });
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  private skipTrivia(): void {
    let advanced = true;
    while (advanced && !this.isAtEnd()) {
      advanced = false;
      while (!this.isAtEnd() && /\s/.test(this.peek())) {
        this.advance();
        advanced = true;
      }

      if (this.matchPrefix("//")) {
        while (!this.isAtEnd() && this.peek() !== "\n") {
          this.advance();
        }
        advanced = true;
      } else if (this.matchPrefix("/*")) {
        const start = this.position();
        this.advance();
        this.advance();
        while (!this.isAtEnd() && !this.matchPrefix("*/")) {
          this.advance();
        }
        if (this.isAtEnd()) {
          this.diagnostics.push({
            severity: "warning",
            message: "Unterminated block comment.",
            location: { path: this.scriptPath, range: { start, end: this.position() } }
          });
        } else {
          this.advance();
          this.advance();
        }
        advanced = true;
      }
    }
  }

  private scanString(start: SourcePosition): void {
    let raw = "";
    let text = "";

    raw += this.advance();
    while (!this.isAtEnd() && this.peek() !== "\"") {
      const ch = this.advance();
      raw += ch;
      if (ch === "\\" && !this.isAtEnd()) {
        const escaped = this.advance();
        raw += escaped;
        text += escaped;
      } else {
        text += ch;
      }
    }

    if (this.isAtEnd()) {
      this.diagnostics.push({
        severity: "warning",
        message: "Unterminated string literal.",
        location: { path: this.scriptPath, range: { start, end: this.position() } }
      });
    } else {
      raw += this.advance();
    }

    this.push("string", text, raw, { start, end: this.position() });
  }

  private scanIdentifier(start: SourcePosition): void {
    let raw = "";
    while (!this.isAtEnd() && isIdentifierPart(this.peek())) {
      raw += this.advance();
    }
    this.push("identifier", raw, raw, { start, end: this.position() });
  }

  private scanNumber(start: SourcePosition): void {
    let raw = "";
    if (this.matchPrefix("0x") || this.matchPrefix("0X")) {
      raw += this.advance();
      raw += this.advance();
      while (!this.isAtEnd() && /[0-9A-Fa-f]/.test(this.peek())) {
        raw += this.advance();
      }
    } else {
      while (!this.isAtEnd() && isDigit(this.peek())) {
        raw += this.advance();
      }
    }
    this.push("number", raw, raw, { start, end: this.position() });
  }

  private scanSymbol(start: SourcePosition): void {
    const two = this.text.slice(this.state.offset, this.state.offset + 2);
    if (multiCharSymbols.has(two)) {
      this.advance();
      this.advance();
      this.push("symbol", two, two, { start, end: this.position() });
      return;
    }

    const ch = this.peek();
    this.advance();
    this.push("symbol", ch, ch, { start, end: this.position() });

    if (!singleCharSymbols.has(ch)) {
      this.diagnostics.push({
        severity: "warning",
        message: `Unexpected character '${ch}'.`,
        location: { path: this.scriptPath, range: { start, end: this.position() } }
      });
    }
  }

  private push(type: TokenType, text: string, raw: string, range: SourceRange): void {
    this.tokens.push({ type, text, raw, range, index: this.tokens.length });
  }

  private isAtEnd(): boolean {
    return this.state.offset >= this.text.length;
  }

  private peek(): string {
    return this.text[this.state.offset] ?? "";
  }

  private advance(): string {
    const ch = this.text[this.state.offset] ?? "";
    this.state.offset++;
    if (ch === "\n") {
      this.state.line++;
      this.state.character = 0;
    } else {
      this.state.character++;
    }
    return ch;
  }

  private position(): SourcePosition {
    return {
      line: this.state.line,
      character: this.state.character,
      offset: this.state.offset
    };
  }

  private matchPrefix(prefix: string): boolean {
    return this.text.startsWith(prefix, this.state.offset);
  }
}

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return /[0-9]/.test(ch);
}
