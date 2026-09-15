export interface Notifier {
  /** Fire-and-forget notification (internal webhook). Never throws. */
  notify(event: { kind: string; title: string; message: string; userId: string; data?: Record<string, unknown> }): Promise<boolean>;
}
