import { describe, expect, it } from "vitest";
import { tokenize } from "../wombat/tokenizer";

describe("Wombat tokenizer", () => {
  it("skips line and block comments without treating comment text as tokens", () => {
    const result = tokenize(`
      // Q999 should not be a symbol
      function void Q4HX(obj it) {
        /* Q888 should not be a symbol either */
        string label = "Q777 stays inside the string";
        Q4HX(it);
      }
    `);

    const identifiers = result.tokens.filter((token) => token.type === "identifier").map((token) => token.text);
    expect(identifiers).toContain("Q4HX");
    expect(identifiers).not.toContain("Q999");
    expect(identifiers).not.toContain("Q888");
    expect(result.tokens.find((token) => token.type === "string")?.text).toContain("Q777");
  });
});
