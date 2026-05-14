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
      const result = validateCommand(
        "cat <<'EOF' > file.txt\nsome content\nEOF",
      );
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
      const result = validateCommand(
        "mkdir -p dir && cat <<'EOF' > dir/file.txt\ncontent\nEOF",
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("write_file");
    });
  });

  describe("non-cat file writers (direct commands)", () => {
    it("rejects tee with file target", () => {
      const result = validateCommand("echo hi | tee out.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain('"tee" with file targets');
      expect(result!.message).toContain("write_file");
    });

    it("rejects tee with heredoc", () => {
      const result = validateCommand(
        "tee /tmp/out.txt >/dev/null <<'EOF'\nhello\nEOF",
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain('"tee" with file targets');
    });

    it("rejects tee append with file target", () => {
      const result = validateCommand("echo hi | tee -a out.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain('"tee" with file targets');
    });

    it("rejects tee with -- separator and file target", () => {
      const result = validateCommand("echo hi | tee -- out.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain('"tee" with file targets');
    });

    it("allows tee without file target", () => {
      expect(validateCommand("echo hi | tee")).toBeNull();
      expect(validateCommand("echo hi | tee -a")).toBeNull();
      expect(validateCommand("echo hi | tee -")).toBeNull();
    });

    it("rejects printf with output redirection", () => {
      const result = validateCommand("printf 'hello\\n' > out.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain('"printf" with output redirection');
      expect(result!.message).toContain("write_file");
    });

    it("rejects echo with output redirection", () => {
      const result = validateCommand("echo hello >> out.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain('"echo" with output redirection');
    });

    it("rejects echo redirection in compound command", () => {
      const result = validateCommand(
        "mkdir -p out && echo hello > out/file.txt",
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain('"echo" with output redirection');
    });

    it("allows echo/printf without file redirection", () => {
      expect(validateCommand("echo hello")).toBeNull();
      expect(validateCommand("printf 'hello\\n'")).toBeNull();
      expect(validateCommand("printf 'x\\n' 2>&1")).toBeNull();
      expect(validateCommand("echo hello >&2")).toBeNull();
    });
  });

  describe("inline Python file writers", () => {
    it("rejects python heredoc that writes a file with pathlib", () => {
      const result = validateCommand(
        [
          "python3 - <<'PY'",
          "from pathlib import Path",
          "Path('out.txt').write_text('hello')",
          "PY",
        ].join("\n"),
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline Python");
      expect(result!.message).toContain("write_file");
      expect(result!.message).toContain("apply_diff");
    });

    it("rejects python -c that writes a file with open(..., 'w')", () => {
      const result = validateCommand(
        `python3 -c "open('out.txt', 'w').write('hello')"`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline Python");
      expect(result!.message).toContain("write_file");
    });

    it("allows inline python that only reads a file", () => {
      expect(
        validateCommand(
          `python3 -c "from pathlib import Path; print(Path('out.txt').read_text())"`,
        ),
      ).toBeNull();
    });
  });

  describe("inline Node/Bun/Deno file writers", () => {
    it("rejects node heredoc that writes a file with fs.writeFileSync", () => {
      const result = validateCommand(
        [
          "node - <<'NODE'",
          "const fs = require('fs');",
          "const path = 'src/foo.ts';",
          "let s = fs.readFileSync(path, 'utf8');",
          "fs.writeFileSync(path, s);",
          "NODE",
        ].join("\n"),
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline JavaScript/TypeScript");
      expect(result!.message).toContain("write_file");
      expect(result!.message).toContain("apply_diff");
    });

    it("rejects node -e that writes a file", () => {
      const result = validateCommand(
        `node -e "require('fs').writeFileSync('out.txt', 'hi')"`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline JavaScript/TypeScript");
    });

    it("rejects node --eval that calls appendFileSync", () => {
      const result = validateCommand(
        `node --eval "require('fs').appendFileSync('out.txt', 'hi')"`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline JavaScript/TypeScript");
    });

    it("rejects bun -e that calls Bun.write", () => {
      const result = validateCommand(
        `bun -e "await Bun.write('out.txt', 'hi')"`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline JavaScript/TypeScript");
    });

    it("rejects deno heredoc that calls Deno.writeTextFile", () => {
      const result = validateCommand(
        [
          "deno eval - <<'TS'",
          "await Deno.writeTextFile('out.txt', 'hi');",
          "TS",
        ].join("\n"),
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline JavaScript/TypeScript");
    });

    it("rejects tsx -e that writes a file", () => {
      const result = validateCommand(
        `tsx -e "import { writeFileSync } from 'fs'; writeFileSync('a', 'b')"`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline JavaScript/TypeScript");
    });

    it("rejects npx tsx -e that writes a file", () => {
      const result = validateCommand(
        `npx tsx -e "require('fs').writeFileSync('a', 'b')"`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline JavaScript/TypeScript");
    });

    it("allows inline node that only reads a file", () => {
      expect(
        validateCommand(
          `node -e "console.log(require('fs').readFileSync('out.txt', 'utf8'))"`,
        ),
      ).toBeNull();
    });
  });

  describe("inline Perl/Ruby/osascript file writers", () => {
    it("rejects perl -e that opens a file for writing", () => {
      const result = validateCommand(
        `perl -e 'open(FH, ">out.txt"); print FH "hi"; close FH;'`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline Perl");
    });

    it("rejects perl -E that unlinks a file", () => {
      const result = validateCommand(`perl -E 'unlink("out.txt")'`);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline Perl");
    });

    it("rejects ruby -e that calls File.write", () => {
      const result = validateCommand(
        `ruby -e 'File.write("out.txt", "hi")'`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline Ruby");
    });

    it("rejects ruby -e that opens a file in write mode", () => {
      const result = validateCommand(
        `ruby -e 'File.open("out.txt", "w") { |f| f.puts "hi" }'`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline Ruby");
    });

    it("rejects osascript -e that writes to a file", () => {
      const result = validateCommand(
        `osascript -e 'write "hi" to file "out.txt"'`,
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("inline osascript");
    });

    it("allows inline ruby that only reads a file", () => {
      expect(
        validateCommand(`ruby -e 'puts File.read("out.txt")'`),
      ).toBeNull();
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

  // ── Shell expansion bypass ─────────────────────────────────────────

  describe("commands with shell expansion (should be allowed)", () => {
    it("allows grep with $() command substitution in path", () => {
      expect(
        validateCommand(
          'grep -r "pattern" $(go env GOMODCACHE)/github.com/pkg*',
        ),
      ).toBeNull();
    });

    it("allows grep with $VAR in path", () => {
      expect(validateCommand("grep -r pattern $GOMODCACHE/pkg")).toBeNull();
    });

    it("allows grep with ${VAR} in path", () => {
      expect(
        validateCommand('grep -r "error" ${HOME}/logs/app.log'),
      ).toBeNull();
    });

    it("allows cat with $() in path", () => {
      expect(validateCommand("cat $(find /tmp -name '*.log')")).toBeNull();
    });

    it("allows head with backtick command substitution", () => {
      expect(
        validateCommand("head -20 `find /var -name error.log`"),
      ).toBeNull();
    });

    it("still rejects grep on plain workspace files", () => {
      const result = validateCommand("grep -i error server.log");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("search_files");
    });

    it("does not treat $ inside single quotes as expansion", () => {
      // grep '$HOME' file.txt — the $HOME is literal (single-quoted)
      const result = validateCommand("grep '$HOME' file.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("search_files");
    });

    it("treats $ inside double quotes as expansion", () => {
      // grep "pattern" "$LOGDIR/app.log" — $LOGDIR is expanded in double quotes
      expect(validateCommand('grep "pattern" "$LOGDIR/app.log"')).toBeNull();
    });
  });

  // ── sed -i (in-place editing) ──────────────────────────────────────

  describe("sed -i (in-place editing)", () => {
    it("rejects sed -i", () => {
      const result = validateCommand("sed -i 's/old/new/' file.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("sed -i");
      expect(result!.message).toContain("apply_diff");
      expect(result!.message).toContain("find_and_replace");
    });

    it("rejects sed --in-place", () => {
      const result = validateCommand("sed --in-place 's/foo/bar/' file.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("sed -i");
    });

    it("rejects sed -i with backup suffix", () => {
      expect(
        validateCommand("sed -i.bak 's/old/new/' file.txt"),
      ).not.toBeNull();
    });

    it("rejects sed -i in compound command", () => {
      const result = validateCommand("cd /tmp && sed -i 's/a/b/' config.yml");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("sed -i");
    });

    it("rejects sed with a file argument (stdout transform)", () => {
      const result = validateCommand("sed 's/old/new/' file.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("apply_diff");
      expect(result!.message).toContain("find_and_replace");
    });

    it("rejects sed -n with a file argument", () => {
      const result = validateCommand("sed -n '5p' file.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("read_file");
      expect(result!.message).toContain("search_files");
    });

    it("rejects sed -n with pattern match", () => {
      const result = validateCommand("sed -n '/error/p' app.log");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("search_files");
    });

    it("rejects sed --quiet", () => {
      const result = validateCommand("sed --quiet '1,10p' data.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("read_file");
    });

    it("rejects sed with -e and file argument", () => {
      const result = validateCommand(
        "sed -e 's/old/new/' -e 's/foo/bar/' file.txt",
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("apply_diff");
    });

    it("allows sed in a pipeline", () => {
      expect(validateCommand("echo hello | sed 's/hello/world/'")).toBeNull();
    });

    it("allows sed -n in a pipeline", () => {
      expect(validateCommand("cat file | sed -n '5p'")).toBeNull();
    });

    it("allows bare sed with no file (reads stdin)", () => {
      expect(validateCommand("sed 's/old/new/'")).toBeNull();
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

  // ── Violation type field ──────────────────────────────────────────

  describe("violation type", () => {
    it("direct violations have type 'direct'", () => {
      const result = validateCommand("cat somefile.txt");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("direct");
    });

    it("sed violations have type 'direct'", () => {
      const result = validateCommand("sed -i 's/a/b/' file.txt");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("direct");
    });

    it("pipe violations have type 'pipe'", () => {
      const result = validateCommand("ls -la | head -5");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("pipe");
    });

    it("pipe violations include force=true warning", () => {
      const result = validateCommand("npm ls | grep express");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("Do NOT retry with force=true");
    });

    it("chained pipe violations have type 'pipe'", () => {
      const result = validateCommand(
        "make build 2>&1 | grep -E 'error|warning' | tail -10",
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("pipe");
      expect(result!.message).toContain("Do NOT retry with force=true");
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
