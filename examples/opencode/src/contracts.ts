import type { NativeEvent } from "@cantelop/sdk/harnesses/native";

export type SessionMessage = { type: "prompt"; prompt: string };
export type SessionEvent = NativeEvent;
