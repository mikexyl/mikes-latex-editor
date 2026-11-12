// Native features offered by the desktop app (electron/preload.cjs); absent in a browser.
type Desktop = {
  platform: string;
  pickFolder(defaultPath?: string): Promise<string | null>;
  revealPath(path: string): Promise<void>;
  /** Missing in desktop apps older than this button; resolves to '' or an error message. */
  openFolder?(path: string): Promise<string>;
  /** Missing in desktop apps older than multi-window support. */
  newWindow?(project?: string): Promise<void>;
};

export const desktop: Desktop | null = (window as unknown as { desktop?: Desktop }).desktop ?? null;
