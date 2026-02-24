export function AvailableTools() {
  return (
    <div class="section">
      <h3>Available Tools</h3>
      <ul class="tools-list">
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
        <li>
          <code>go_to_definition</code> — Jump to symbol definition
        </li>
        <li>
          <code>get_references</code> — Find all usages
        </li>
        <li>
          <code>get_symbols</code> — Document/workspace symbols
        </li>
        <li>
          <code>get_hover</code> — Types &amp; documentation
        </li>
        <li>
          <code>get_completions</code> — Autocomplete suggestions
        </li>
        <li>
          <code>open_file</code> — Open in editor
        </li>
        <li>
          <code>show_notification</code> — VS Code notification
        </li>
        <li>
          <code>write_file</code> — Create/overwrite with diff review
        </li>
        <li>
          <code>apply_diff</code> — Search/replace with diff review
        </li>
        <li>
          <code>rename_symbol</code> — Rename across workspace
        </li>
        <li>
          <code>execute_command</code> — Integrated terminal
        </li>
        <li>
          <code>codebase_search</code> — Semantic code search
        </li>
        <li>
          <code>close_terminals</code> — Clean up terminals
        </li>
      </ul>
    </div>
  );
}
