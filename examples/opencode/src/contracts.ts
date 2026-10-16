import type { NativeEvent } from "../../native-harness/cli.ts";

export type SessionMessage = { type: "prompt"; prompt: string };
export type SessionEvent = NativeEvent;
