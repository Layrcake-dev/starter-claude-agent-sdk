import { describe, expect, it } from "vitest";
import { instructions, SIGN_OFF_PLACEHOLDER } from "../src/instructions.js";

describe("the sign-off rule", () => {
  it("signs every email with SENDER_NAME and never invents a sender", () => {
    const prompt = instructions({ budget: 100, dryRun: false, senderName: "Sam Carter" });
    expect(prompt).toContain("End every email with this sign-off line, exactly as written: Sam Carter\n");
    expect(prompt).toContain("never invent a name, title or company for the sender");
    expect(prompt).not.toContain(SIGN_OFF_PLACEHOLDER);
  });

  it("signs every email [Your name] without SENDER_NAME and says so in the report", () => {
    for (const senderName of [undefined, "", "   "]) {
      const prompt = instructions({ budget: 100, dryRun: false, senderName });
      expect(prompt).toContain("End every email with this sign-off line, exactly as written: [Your name]\n");
      expect(prompt).toContain("never invent a name, title or company for the sender");
      expect(prompt).toMatch(/Also say that every email is signed \[Your name\] and the sign-off must be filled in before the campaign\s+is approved\.$/);
    }
  });

  it("keeps the rule in a dry run", () => {
    expect(instructions({ budget: 100, dryRun: true, senderName: "Sam Carter" })).toContain("exactly as written: Sam Carter\n");
    expect(instructions({ budget: 100, dryRun: true })).toContain("exactly as written: [Your name]\n");
  });
});
