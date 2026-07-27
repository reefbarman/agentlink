import { randomUUID } from "crypto";

export interface WebviewShellOptions {
  title: string;
  cspSource: string;
  scriptUri: string;
  styleUris: string[];
  nonce?: string;
  scriptSourceAdditions?: string[];
  imageSources?: string[];
  bodyPrefix?: string;
}

export function renderWebviewShell(options: WebviewShellOptions): string {
  const nonce = options.nonce ?? randomUUID().replace(/-/g, "");
  const styles = options.styleUris
    .map((styleUri) => `  <link rel="stylesheet" href="${styleUri}">`)
    .join("\n");

  const scriptSources = [
    `'nonce-${nonce}'`,
    ...(options.scriptSourceAdditions ?? []),
  ].join(" ");
  const imageDirective = options.imageSources?.length
    ? ` img-src ${options.imageSources.join(" ")};`
    : "";
  const bodyPrefix = options.bodyPrefix ? `  ${options.bodyPrefix}\n` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${options.cspSource} 'unsafe-inline'; script-src ${scriptSources}; font-src ${options.cspSource};${imageDirective}">
${styles}
  <title>${options.title}</title>
</head>
<body>
${bodyPrefix}  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${options.scriptUri}"></script>
</body>
</html>`;
}
