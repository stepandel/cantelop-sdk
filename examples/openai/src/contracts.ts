export interface PromptInput {
  type: "message" | "steer";
  prompt: string;
}

export interface ChatRequest extends PromptInput {
  sessionId?: string;
  workspaceId: string;
  keepAliveSeconds: number;
}

export interface SteerRequest extends PromptInput {
  sessionId: string;
  workspaceId: string;
  keepAliveSeconds: number;
}

export interface AnswerOutput {
  answer: string;
}
