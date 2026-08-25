export type PromptInput =
  | { type: "message" | "steer"; prompt: string }
  | { type: "cancel" };

export interface ChatRequest {
  sessionId?: string;
  workspaceId: string;
  keepAliveSeconds: number;
  prompt: string;
}

export interface SteerRequest {
  sessionId: string;
  workspaceId: string;
  keepAliveSeconds: number;
  prompt: string;
}

export interface CancelRequest {
  sessionId: string;
  workspaceId: string;
  keepAliveSeconds: number;
}

export interface AnswerOutput {
  answer: string;
}
