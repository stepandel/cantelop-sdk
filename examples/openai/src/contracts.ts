export interface PromptInput {
  prompt: string;
}

export interface AnswerOutput {
  answer: string;
}

export type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: AnswerOutput };
