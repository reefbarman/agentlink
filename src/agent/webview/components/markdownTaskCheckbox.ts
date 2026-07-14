export function renderMarkdownTaskCheckbox(checked: boolean): string {
  const checkedClass = checked ? " markdown-task-checkbox-checked" : "";
  const checkmark = checked ? "&#10003;" : "";

  return `<span class="markdown-task-checkbox${checkedClass}" aria-hidden="true">${checkmark}</span> `;
}
