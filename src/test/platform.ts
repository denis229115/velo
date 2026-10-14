const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const original = navigator.userAgent;

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

/** Make the webview report macOS or Windows until restoreUserAgent(). */
export function pretendPlatform(platform: "mac" | "windows") {
  setUserAgent(platform === "mac" ? MAC_UA : WINDOWS_UA);
}

export function restoreUserAgent() {
  setUserAgent(original);
}
