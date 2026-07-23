import mermaid from "mermaid";

let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    securityLevel: "loose",
    fontFamily: "var(--vscode-font-family)",
    themeVariables: {
      primaryColor: "#2a5e58",
      primaryTextColor: "#e0e0e0",
      primaryBorderColor: "#4EC9B0",
      secondaryColor: "#1e3a36",
      secondaryTextColor: "#e0e0e0",
      secondaryBorderColor: "#3ba89f",
      tertiaryColor: "#163330",
      tertiaryTextColor: "#e0e0e0",
      tertiaryBorderColor: "#2d7a72",
      lineColor: "#4EC9B0",
      textColor: "#e0e0e0",
      mainBkg: "#2a5e58",
      nodeBorder: "#4EC9B0",
      noteBkgColor: "#1e3a36",
      noteTextColor: "#e0e0e0",
      noteBorderColor: "#4EC9B0",
      actorBkg: "#2a5e58",
      actorBorder: "#4EC9B0",
      actorTextColor: "#e0e0e0",
      actorLineColor: "#4EC9B0",
      signalColor: "#e0e0e0",
      signalTextColor: "#e0e0e0",
      labelBoxBkgColor: "#1e3a36",
      labelBoxBorderColor: "#4EC9B0",
      labelTextColor: "#e0e0e0",
      loopTextColor: "#e0e0e0",
      activationBorderColor: "#4EC9B0",
      activationBkgColor: "#1e3a36",
      sequenceNumberColor: "#1a1a2e",
      pie1: "#4EC9B0",
      pie2: "#3ba89f",
      pie3: "#2d7a72",
      pie4: "#1e5c56",
      pie5: "#164e48",
      pie6: "#0e3d38",
      pie7: "#082e2a",
      pieTitleTextColor: "#e0e0e0",
      pieSectionTextColor: "#1a1a2e",
      git0: "#4EC9B0",
      git1: "#3ba89f",
      git2: "#2d7a72",
      git3: "#1e5c56",
      gitBranchLabel0: "#1a1a2e",
      gitBranchLabel1: "#1a1a2e",
      gitBranchLabel2: "#e0e0e0",
      gitBranchLabel3: "#e0e0e0",
      entityBorder: "#4EC9B0",
      entityBkg: "#2a5e58",
      entityTextColor: "#e0e0e0",
      relationColor: "#4EC9B0",
      attributeBackgroundColorEven: "#1e3a36",
      attributeBackgroundColorOdd: "#2a5e58",
    },
  });
}

export async function renderMermaid(
  source: string,
  id: string,
): Promise<string> {
  ensureInitialized();
  const { svg } = await mermaid.render(id, source);
  return svg;
}
