export async function closeWindowAndConfirm(windowId: number): Promise<boolean> {
  try {
    await browser.windows.remove(windowId);
    return true;
  } catch {
    try {
      const windows = await browser.windows.getAll();
      return !windows.some((window) => window.id === windowId);
    } catch {
      return false;
    }
  }
}
