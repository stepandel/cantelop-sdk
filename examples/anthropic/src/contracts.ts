export interface PromptInput {
  prompt: string;
}

export interface ExecuteRequest extends PromptInput {
  sessionId: string;
}

export interface CreateSessionRequest {
  workspaceId: string;
  keepAliveSeconds: number;
}

export interface AnswerOutput {
  answer: string;
}
