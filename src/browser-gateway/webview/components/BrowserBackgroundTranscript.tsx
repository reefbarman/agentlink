import type { BgSessionInfoProps } from "../../../agent/webview/components/BackgroundSessionStrip";
import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import type { OpenImageInEditor } from "../../../agent/webview/components/ImagePreview";
import { TranscriptView } from "../../../agent/webview/components/TranscriptView";

interface BrowserBackgroundTranscriptProps {
  task: string;
  sessionId: string;
  messages: ChatMessage[];
  streaming: boolean;
  runtimeStatus?: BgSessionInfoProps;
  sessions: BgSessionInfoProps[];
  workspaceActionsEnabled: boolean;
  onOpenFile: (path: string, line?: number) => void;
  onOpenImageInEditor: OpenImageInEditor;
  onRetry: () => void;
  onSignIn: () => void;
  onSignInAnotherAccount: () => void;
  onStopBackground: (sessionId: string) => void;
  onOpenTranscript: (sessionId: string) => void;
  onClose: () => void;
}

/**
 * Browser host boundary for the shared background transcript. Display and
 * VS Code-hosted actions are available only for mirrored workspace tabs;
 * Browser Ask Agent must not inherit instance-backed controls.
 */
export function BrowserBackgroundTranscript({
  task,
  sessionId,
  messages,
  streaming,
  runtimeStatus,
  sessions,
  workspaceActionsEnabled,
  onOpenFile,
  onOpenImageInEditor,
  onRetry,
  onSignIn,
  onSignInAnotherAccount,
  onStopBackground,
  onOpenTranscript,
  onClose,
}: BrowserBackgroundTranscriptProps) {
  return (
    <TranscriptView
      task={task}
      sessionId={sessionId}
      messages={messages}
      streaming={streaming}
      runtimeStatus={runtimeStatus}
      onOpenFile={workspaceActionsEnabled ? onOpenFile : undefined}
      onOpenImageInEditor={
        workspaceActionsEnabled ? onOpenImageInEditor : undefined
      }
      onRetry={workspaceActionsEnabled ? onRetry : undefined}
      onSignIn={workspaceActionsEnabled ? onSignIn : undefined}
      onSignInAnotherAccount={
        workspaceActionsEnabled ? onSignInAnotherAccount : undefined
      }
      bgSessions={workspaceActionsEnabled ? sessions : undefined}
      onStopBackground={workspaceActionsEnabled ? onStopBackground : undefined}
      onOpenTranscript={workspaceActionsEnabled ? onOpenTranscript : undefined}
      onClose={onClose}
    />
  );
}
