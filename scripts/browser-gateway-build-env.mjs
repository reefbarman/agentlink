export function resolveBrowserGatewayDevBuild(
  environmentValue,
  envLocalContent,
) {
  if (environmentValue !== undefined) return environmentValue === "true";
  return /^DEV_BUILD\s*=\s*true$/m.test(envLocalContent ?? "");
}
