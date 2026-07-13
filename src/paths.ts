import path from "node:path";
import { DmsumError } from "./errors.js";

export interface ResolvedVaultPath {
  relativePath: string;
  absolutePath: string;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new DmsumError("Path escapes the Mem·Sum vault");
}

export function normalizeVaultRelativePath(input: string, allowRoot = false): string {
  if (input.includes("\0")) {
    throw new DmsumError("Path contains an invalid null byte");
  }

  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") {
    if (allowRoot) return "";
    throw new DmsumError("Path is required");
  }

  if (
    path.win32.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed) ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    throw new DmsumError("Path must be relative to the Mem·Sum vault");
  }

  const slashPath = trimmed.replace(/\\/g, "/");
  if (slashPath.includes(":")) {
    throw new DmsumError("Path contains an invalid ':' character");
  }

  const normalized = path.posix.normalize(slashPath);
  if (normalized === "." && allowRoot) return "";
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new DmsumError("Path traversal is not allowed");
  }

  return normalized;
}

export function resolveVaultPath(
  vaultRoot: string,
  requestedPath: string,
  allowRoot = false
): ResolvedVaultPath {
  const root = path.resolve(vaultRoot);
  const relativePath = normalizeVaultRelativePath(requestedPath, allowRoot);
  const absolutePath = path.resolve(root, relativePath.split("/").join(path.sep));
  assertInside(root, absolutePath);
  return { relativePath, absolutePath };
}

export function isWikiPath(relativePath: string): boolean {
  return relativePath === "wiki" || relativePath.startsWith("wiki/");
}

export function interactionFilePath(args: { year: string; month: string; day: string; interactionId: string }): string {
  return `interactions/${args.year}/${args.month}/${args.day}/${args.interactionId}.md`;
}

export function wikiUpdateFilePath(args: { year: string; month: string; day: string; updateId: string }): string {
  return `wiki-updates/${args.year}/${args.month}/${args.day}/${args.updateId}.md`;
}

export function conflictFilePath(args: { year: string; month: string; day: string; conflictId: string }): string {
  return `conflicts/${args.year}/${args.month}/${args.day}/${args.conflictId}.md`;
}

export function displayPath(relativePath: string): string {
  return relativePath || ".";
}
