import fs from "node:fs/promises";
import path from "node:path";
import type { LocalState } from "./types.js";

const defaultState: LocalState = {
  nextInteractionNumber: 1,
  nextWikiUpdateNumber: 1,
  nextConflictNumber: 1
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function stateFilePath(stateDir: string): string {
  return path.join(stateDir, "state.json");
}

export async function readState(stateDir: string): Promise<LocalState> {
  const statePath = stateFilePath(stateDir);
  if (!(await fileExists(statePath))) {
    return { ...defaultState };
  }

  const raw = await fs.readFile(statePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<LocalState>;
  const migratedWikiUpdateNumber =
    parsed.nextWikiUpdateNumber ?? parsed.nextUpdateNumber ?? defaultState.nextWikiUpdateNumber;
  return {
    nextInteractionNumber: parsed.nextInteractionNumber ?? defaultState.nextInteractionNumber,
    nextWikiUpdateNumber: migratedWikiUpdateNumber,
    nextConflictNumber: parsed.nextConflictNumber ?? defaultState.nextConflictNumber
  };
}

export async function writeState(stateDir: string, state: LocalState): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = stateFilePath(stateDir);
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, statePath);
}

export async function allocateInteractionId(stateDir: string): Promise<string> {
  const state = await readState(stateDir);
  const interactionId = `I${String(state.nextInteractionNumber).padStart(6, "0")}`;
  await writeState(stateDir, {
    ...state,
    nextInteractionNumber: state.nextInteractionNumber + 1
  });
  return interactionId;
}

export async function allocateWikiUpdateId(stateDir: string): Promise<string> {
  const state = await readState(stateDir);
  const updateId = `W${String(state.nextWikiUpdateNumber).padStart(6, "0")}`;
  await writeState(stateDir, {
    ...state,
    nextWikiUpdateNumber: state.nextWikiUpdateNumber + 1
  });
  return updateId;
}

export async function allocateConflictId(stateDir: string): Promise<string> {
  const state = await readState(stateDir);
  const nextConflictNumber = state.nextConflictNumber ?? 1;
  const conflictId = `C${String(nextConflictNumber).padStart(6, "0")}`;
  await writeState(stateDir, {
    ...state,
    nextConflictNumber: nextConflictNumber + 1
  });
  return conflictId;
}
