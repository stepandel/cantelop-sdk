export type SessionMessage = { type: "prompt"; prompt: string };

export type SessionEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; answer: string };
