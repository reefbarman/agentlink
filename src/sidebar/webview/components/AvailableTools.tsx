export function AvailableTools() {
  return (
    <div class="section">
      <h3>Available Tools</h3>
      <ul class="tools-list">
        <li>
          <code>write_file</code> — Create/overwrite with diff review
        </li>
        <li>
          <code>apply_diff</code> — Search/replace with diff review
        </li>
        <li>
          <code>execute_command</code> — Integrated terminal
        </li>
        <li>
          <code>read_file</code> — Read with line numbers
        </li>
        <li>
          <code>list_files</code> — Directory listing
        </li>
        <li>
          <code>search_files</code> — Regex search
        </li>
        <li>
          <code>get_diagnostics</code> — Errors &amp; warnings
        </li>
      </ul>
    </div>
  );
}
