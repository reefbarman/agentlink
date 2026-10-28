export interface TuiControlOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly tone?: "normal" | "danger";
}

export interface TuiControlRequest {
  readonly id: string;
  readonly kind?: "approval" | "question" | "selector" | "detail" | "help";
  readonly title: string;
  readonly body: readonly string[];
  readonly options?: readonly TuiControlOption[];
  /** Option highlighted when the panel opens. */
  readonly initialOptionId?: string;
  /** Space toggles options; Enter returns them as `optionIds`. */
  readonly multiSelect?: boolean;
  readonly input?: {
    readonly placeholder: string;
    readonly initialValue?: string;
  };
  readonly cancellable?: boolean;
}

export type TuiControlResponse =
  | {
      readonly requestId: string;
      readonly cancelled: true;
      readonly terminate?: true;
    }
  | {
      readonly requestId: string;
      readonly cancelled: false;
      readonly optionId?: string;
      /** Ticked options of a `multiSelect` request, in option order. */
      readonly optionIds?: readonly string[];
      readonly text?: string;
    };

export type PresentTuiControl = (
  request: TuiControlRequest,
  signal?: AbortSignal,
) => Promise<TuiControlResponse>;
