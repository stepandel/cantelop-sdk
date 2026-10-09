export type SessionMessage =
  | { type: "prompt" | "steer"; prompt: string }
  | { type: "cancel" };

export type SessionEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; answer: string };
