import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../wombat/parser";

describe("Wombat parser", () => {
  it("extracts inheritance, members, functions, params, locals, and references", () => {
    const parsed = parseSourceFile({
      name: "wearweak",
      path: "wearweak.m",
      text: `
        inherits wearstat;
        member int Q5X6;
        function void Q4HX(obj it) {
          int Q54U;
          Q54U = Q5X6;
          detachScript(it, "wearweak");
          return();
        }
      `
    });

    expect(parsed.parent).toBe("wearstat");
    expect(parsed.members.map((member) => member.name)).toEqual(["Q5X6"]);
    expect(parsed.functions[0]?.name).toBe("Q4HX");
    expect(parsed.functions[0]?.signature).toBe("vo");
    expect(parsed.functions[0]?.params[0]?.name).toBe("it");
    expect(parsed.functions[0]?.locals.map((local) => local.name)).toEqual(["Q54U"]);
    expect(parsed.functions[0]?.references.map((ref) => ref.name)).toContain("Q5X6");
  });

  it("treats member declarations inside trigger/function bodies as script-scope members", () => {
    const parsed = parseSourceFile({
      name: "build",
      path: "build.m",
      text: `
        trigger creation {
          member list Q5ZF;
          member int Q542 = 0x00;
          int Q4Q1;
          Q4Q1 = Q542;
        }
      `
    });

    expect(parsed.members.map((member) => member.name)).toEqual(["Q5ZF", "Q542"]);
    expect(parsed.triggers[0]?.locals.map((local) => local.name)).toEqual(["Q4Q1"]);
  });
});
