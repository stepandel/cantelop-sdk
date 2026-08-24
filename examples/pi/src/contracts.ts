export interface PromptInput {
  prompt: string;
}

export interface ExecuteRequest extends PromptInput {
  sessionId: string;
}

export interface DispatchRequest extends PromptInput {
  workspaceId: string;
  sessionKey: string;
  keepAliveSeconds: number;
}

export interface CreateSessionRequest {
  workspaceId: string;
  keepAliveSeconds: number;
}

export interface AnswerOutput {
  answer: string;
}
