/** The prompt/output subset of the OpenAI runtime example's contract. */
export type ChatMessage = { type: "prompt"; prompt: string };
export type ChatEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; answer: string };
