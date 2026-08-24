export interface PromptInput {
  prompt: string;
}

export interface SessionExecutionRequest extends PromptInput {
  sessionId?: string;
  workspaceId: string;
  keepAliveSeconds: number;
}

export interface AnswerOutput {
  answer: string;
}
