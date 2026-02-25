import { describe, it, expect } from "vitest";
import { validateCommand } from "./pipeValidator.js";

describe("validateCommand", () => {
  // ── Direct file-reading commands ──────────────────────────────────

  describe("cat (read context)", () => {
    it("rejects cat with a file argument", () => {
      const result = validateCommand("cat somefile.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("read_file");
    });

    it("rejects cat with a quoted path", () => {
      const result = validateCommand('cat "path with spaces/file.txt"');
      expect(result).not.toBeNull();
      expect(result!.message).toContain("read_file");
    });
  });

  describe("cat (write context — heredoc/redirect)", () => {
    it("rejects cat with heredoc but suggests write_file/apply_diff", () => {
      const result = validateCommand("cat <<'EOF' > file.txt\nsome content\nEOF");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("write_file");
      expect(result!.message).toContain("apply_diff");
      expect(result!.message).not.toContain("read_file");
    });

    it("rejects cat with unquoted heredoc", () => {
      const result = validateCommand("cat <<EOF > output.txt\nhello\nEOF");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("write_file");
    });

    it("rejects cat with output redirect >", () => {
      const result = validateCommand("cat > newfile.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("write_file");
      expect(result!.message).not.toContain("read_file");
    });

    it("rejects cat with append redirect >>", () => {
      const result = validateCommand("cat >> existing.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("write_file");
    });

    it("rejects heredoc cat in compound command", () => {
      const result = validateCommand("mkdir -p dir && cat <<'EOF' > dir/file.txt\ncontent\nEOF");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("write_file");
    });
  });

  describe("head", () => {
    it("rejects head with a file argument", () => {
      const result = validateCommand("head -20 server.log");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("read_file");
      expect(result!.message).toContain("20");
    });

    it("rejects head with default line count", () => {
      const result = validateCommand("head README.md");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("read_file");
    });
  });

  describe("tail", () => {
    it("rejects tail with a file argument", () => {
      const result = validateCommand("tail -50 app.log");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("read_file");
    });
  });

  describe("grep", () => {
    it("rejects grep with a pattern and file", () => {
      const result = validateCommand("grep -i error server.log");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("search_files");
    });

    it("rejects grep with only a pattern", () => {
      const result = validateCommand("grep TODO");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("search_files");
    });
  });

  // ── Piped filtering ───────────────────────────────────────────────

  describe("piped head/tail/grep", () => {
    it("rejects piped head", () => {
      const result = validateCommand("ls -la | head -5");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("output_head");
      expect(result!.strippedCommand).toBe("ls -la");
    });

    it("rejects piped tail", () => {
      const result = validateCommand("git log | tail -20");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("output_tail");
      expect(result!.strippedCommand).toBe("git log");
    });

    it("rejects piped grep", () => {
      const result = validateCommand('npm ls | grep "express"');
      expect(result).not.toBeNull();
      expect(result!.message).toContain("output_grep");
      expect(result!.strippedCommand).toBe("npm ls");
    });

    it("rejects chained pipe filters", () => {
      const result = validateCommand("ps aux | grep node | head -5");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("output_grep");
      expect(result!.message).toContain("output_head");
    });

    it("provides stripped command without pipe filters", () => {
      const result = validateCommand("docker ps | grep running | head -3");
      expect(result).not.toBeNull();
      expect(result!.strippedCommand).toBe("docker ps");
    });
  });

  // ── cat in pipelines ──────────────────────────────────────────────

  describe("cat in pipelines (should be allowed)", () => {
    it("allows cat piped to another command", () => {
      expect(validateCommand("cat file1 file2 | diff -")).toBeNull();
    });

    it("allows cat piped to sort", () => {
      expect(validateCommand("cat file1.txt file2.txt | sort")).toBeNull();
    });

    it("allows cat piped to wc", () => {
      expect(validateCommand("cat data.csv | wc -l")).toBeNull();
    });

    it("still rejects standalone cat", () => {
      const result = validateCommand("cat somefile.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("read_file");
    });
  });

  // ── Allowed commands ──────────────────────────────────────────────

  describe("allowed commands", () => {
    it("allows normal commands", () => {
      expect(validateCommand("git status")).toBeNull();
    });

    it("allows npm commands", () => {
      expect(validateCommand("npm run build")).toBeNull();
    });

    it("allows piping to non-restricted commands", () => {
      expect(validateCommand("echo hello | wc -l")).toBeNull();
    });

    it("allows compound commands without restricted tools", () => {
      expect(validateCommand("mkdir -p dist && npm run build")).toBeNull();
    });

    it("allows commands with grep/cat/head in arguments (not as command)", () => {
      expect(validateCommand("echo 'use grep to search'")).toBeNull();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty command", () => {
      expect(validateCommand("")).toBeNull();
    });

    it("handles whitespace-only command", () => {
      expect(validateCommand("   ")).toBeNull();
    });

    it("does not split on || (logical OR)", () => {
      // "git pull || echo failed" — should not treat the second part as piped
      expect(validateCommand("git pull || echo failed")).toBeNull();
    });
  });
});
