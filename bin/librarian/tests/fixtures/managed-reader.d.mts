export interface ScriptedTurn {
  prompt: string;
  answer: string;
  model: string;
  level: string;
}
export const first: ScriptedTurn;
export const comparison: ScriptedTurn;
export const materialTurn: ScriptedTurn;
export const acrossSpaces: ScriptedTurn;
export const followUpAcrossSpaces: ScriptedTurn;
export const privateMarkers: string[];
export interface ManagedReader {
  url: string;
  failure(): string | undefined;
  finish(turn: ScriptedTurn): void;
  verify(turns: ScriptedTurn[]): void;
  close(): Promise<void>;
}
export function startManagedReader(): Promise<ManagedReader>;
