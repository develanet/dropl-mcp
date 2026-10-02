import { spawn as nodeSpawn } from "node:child_process";
import { assertSecureUrl } from "./config.js";

/** `cmd` would still interpret `&`, `|`, `%`, quotes and the like inside an argument, so only plain URLs are handed to it. */
const CMD_SAFE_URL_PATTERN = /^[A-Za-z0-9:/?=._~#-]+$/;

export interface BrowserCommand {
  command: string;
  args: string[];
}

export function browserCommand(url: string, platform: NodeJS.Platform): BrowserCommand | null {
  try {
    assertSecureUrl(new URL(url), "The sign-in URL");
  } catch {
    return null;
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    if (!CMD_SAFE_URL_PATTERN.test(url)) return null;
    // The empty string is `start`'s window title; without it a quoted URL would be taken as the title.
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/** Best effort: returns whether a browser launch was attempted. Failures are ignored; the URL is printed anyway. */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: typeof nodeSpawn = nodeSpawn,
): boolean {
  const launch = browserCommand(url, platform);
  if (!launch) return false;
  try {
    const child = spawn(launch.command, launch.args, { stdio: "ignore", detached: true, shell: false, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
