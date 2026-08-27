export type SessionMessage =
  | { type: "prompt" | "steer"; prompt: string }
  | { type: "cancel" };

export type SessionEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; answer: string };

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

export interface EventsRequest {
  sessionId: string;
  workspaceId: string;
  keepAliveSeconds: number;
}
