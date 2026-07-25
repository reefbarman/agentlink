import type { ModeInfo, SlashCommandInfo, WebviewModelInfo } from "../types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import type { RefObject } from "preact";

export type SlashCommandView = "main" | "mode" | "model" | "mcp-config";

interface UseSlashCommandPopupOptions {
  commands: SlashCommandInfo[];
  modes: ModeInfo[];
  currentMode: string;
  availableModels: WebviewModelInfo[];
  currentModel: string;
  matchedCommand: SlashCommandInfo | null;
  inputWrapperRef: RefObject<HTMLDivElement>;
}

export function withSlashCommandDisplayName(
  command: SlashCommandInfo,
): SlashCommandInfo {
  if (command.source !== "skill" || command.displayName) return command;
  return { ...command, displayName: command.name.replace(/^skill:/, "") };
}

export function useSlashCommandPopup({
  commands,
  modes,
  currentMode,
  availableModels,
  currentModel,
  matchedCommand,
  inputWrapperRef,
}: UseSlashCommandPopupOptions) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(-1);
  const [view, setView] = useState<SlashCommandView>("main");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);

  const displayCommands = commands;
  const modelList = useMemo(
    () =>
      availableModels.map((model) => ({
        id: model.id,
        label: model.displayName,
      })),
    [availableModels],
  );

  const filteredCommands = useMemo<SlashCommandInfo[]>(() => {
    if (view === "mode") {
      return modes.map((mode) => ({
        name: `__mode:${mode.slug}`,
        description: mode.name,
        source: "builtin",
        builtin: true,
        icon: mode.icon,
        isCurrent: mode.slug === currentMode,
      }));
    }
    if (view === "model") {
      return modelList.map((model) => ({
        name: `__model:${model.id}`,
        description: model.label,
        source: "builtin",
        builtin: true,
        icon: "symbol-namespace",
        isCurrent: model.id === currentModel,
      }));
    }
    if (view === "mcp-config") {
      return [
        {
          name: "__mcp:project",
          description: "Project (.agentlink/mcp.json)",
          source: "builtin",
          builtin: true,
          icon: "folder",
        },
        {
          name: "__mcp:global",
          description: "Global (~/.agentlink/mcp.json)",
          source: "builtin",
          builtin: true,
          icon: "home",
        },
      ];
    }

    const currentModeName =
      modes.find((mode) => mode.slug === currentMode)?.name ?? currentMode;
    const currentModelLabel =
      modelList.find((model) => model.id === currentModel)?.label ??
      currentModel;
    const normalizedQuery = query.toLowerCase();
    return displayCommands
      .filter(
        (command) =>
          command.name.toLowerCase().startsWith(normalizedQuery) ||
          command.displayName?.toLowerCase().startsWith(normalizedQuery),
      )
      .map((command) => {
        if (command.name === "mode")
          return {
            ...command,
            icon: "symbol-misc",
            rightLabel: currentModeName,
          };
        if (command.name === "model")
          return {
            ...command,
            icon: "symbol-namespace",
            rightLabel: currentModelLabel,
          };
        if (command.name === "new") return { ...command, icon: "add" };
        if (command.name === "clear") return { ...command, icon: "clear-all" };
        if (command.name === "help") return { ...command, icon: "question" };
        if (command.name === "skills") return { ...command, icon: "sparkle" };
        if (command.name === "condense") return { ...command, icon: "fold" };
        if (command.name === "checkpoint")
          return { ...command, icon: "git-commit" };
        if (command.name === "revert") return { ...command, icon: "history" };
        if (command.name === "btw")
          return { ...command, icon: "comment-discussion" };
        if (command.name === "pair")
          return { ...command, icon: "device-mobile" };
        return command;
      });
  }, [
    view,
    modes,
    currentMode,
    modelList,
    currentModel,
    query,
    displayCommands,
  ]);

  const hasPrefixAlternatives = useMemo(() => {
    if (!matchedCommand || view !== "main") return false;
    const exactName = matchedCommand.name.toLowerCase();
    const exactDisplayName = (
      matchedCommand.displayName ?? matchedCommand.name
    ).toLowerCase();
    return displayCommands.some((command) => {
      const name = command.name.toLowerCase();
      const displayName = (command.displayName ?? command.name).toLowerCase();
      return (
        name !== exactName &&
        displayName !== exactDisplayName &&
        (name.startsWith(exactDisplayName) ||
          displayName.startsWith(exactDisplayName))
      );
    });
  }, [matchedCommand, view, displayCommands]);

  const visible =
    open &&
    filteredCommands.length > 0 &&
    (!matchedCommand || hasPrefixAlternatives);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setStart(-1);
    setSelectedIndex(0);
    setView("main");
  }, []);

  const openAt = useCallback((slashStart: number) => {
    setStart(slashStart);
    setQuery("");
    setOpen(true);
    setSelectedIndex(0);
    setView("main");
  }, []);

  const updateFromInput = useCallback(
    (value: string, cursor: number) => {
      if (!open || start < 0) return;
      const nextQuery = value.slice(start + 1, cursor);
      if (nextQuery.includes("\n") || cursor <= start) {
        close();
      } else if (nextQuery.includes(" ")) {
        setQuery(nextQuery.split(" ")[0]);
      } else {
        setQuery(nextQuery);
        setSelectedIndex(0);
      }
    },
    [open, start, close],
  );

  const enterView = useCallback((nextView: SlashCommandView) => {
    setView(nextView);
    setSelectedIndex(0);
  }, []);
  const back = useCallback(() => {
    setView("main");
    setSelectedIndex(0);
  }, []);
  const selectNext = useCallback((count: number) => {
    setSelectedIndex((index) => (index + 1) % count);
  }, []);
  const selectPrevious = useCallback((count: number) => {
    setSelectedIndex((index) => (index <= 0 ? count - 1 : index - 1));
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popupRef.current?.contains(target)) return;
      if (inputWrapperRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, close, inputWrapperRef]);

  return {
    open,
    start,
    view,
    selectedIndex,
    popupRef,
    displayCommands,
    filteredCommands,
    visible,
    close,
    openAt,
    updateFromInput,
    enterView,
    back,
    selectNext,
    selectPrevious,
  };
}
