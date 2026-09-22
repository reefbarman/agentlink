// vsce counts the shipped native runtimes and browser chunks as unbundled JavaScript.
// Suppress only that known false positive; keep every other warning visible.
export function filterVsceFileCountWarning(stderr) {
  return stderr.replace(
    /^\s?WARNING  This extension consists of \d+ files, out of which \d+ are JavaScript files\. For performance reasons, you should bundle your extension: https:\/\/aka\.ms\/vscode-bundle-extension\. You should also exclude unnecessary files by adding them to your \.vscodeignore: https:\/\/aka\.ms\/vscode-vscodeignore\.\r?\n\r?\n?/gm,
    "",
  );
}
