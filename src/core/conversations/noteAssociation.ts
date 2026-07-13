/** Remaps an exact note path or any descendant path when a vault entry moves or is deleted. */
export function remapConversationNotePath(
  notePath: string | null,
  oldPath: string,
  newPath: string | null,
): string | null {
  if (!notePath || !oldPath) {
    return notePath;
  }

  if (notePath === oldPath) {
    return newPath;
  }

  const oldPrefix = `${oldPath}/`;
  if (!notePath.startsWith(oldPrefix)) {
    return notePath;
  }

  return newPath ? `${newPath}${notePath.slice(oldPath.length)}` : null;
}
