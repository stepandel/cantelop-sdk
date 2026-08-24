export interface PromptInput {
  prompt: string;
}

export interface ChatRequest extends PromptInput {
  sessionId?: string;
  keepAliveSeconds: number;
}

export interface SteerRequest extends PromptInput {
  sessionId: string;
  keepAliveSeconds: number;
}

export interface AnswerOutput {
  answer: string;
}
