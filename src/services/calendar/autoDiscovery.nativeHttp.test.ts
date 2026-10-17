// Exercise the installed HTTP plugin, mocking only the native IPC boundary.
// A mock of plugin-http.fetch would miss unsupported browser Request options.
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { discoverCalDavSettings } from "./autoDiscovery";

afterEach(() => clearMocks());

interface ClientConfig {
  url: string;
  method: string;
  maxRedirections?: number;
}

const configs: ClientConfig[] = [];
let wellKnownStatus = 301;
let location = "/dav/calendars/";

beforeEach(() => {
  configs.length = 0;
  wellKnownStatus = 301;
  location = "/dav/calendars/";
  mockIPC((command, args) => {
    const payload = args as { clientConfig: ClientConfig; rid: number };
    if (command === "plugin:http|fetch") {
      configs.push(payload.clientConfig);
      return configs.length - 1;
    }
    if (command === "plugin:http|fetch_send") {
      const config = configs[payload.rid]!;
      const wellKnown = config.url.endsWith("/.well-known/caldav");
      // Model a 301 followed by an authenticated DAV endpoint: automatic
      // redirects swallow Location and expose only the final 401.
      const manual = config.maxRedirections === 0;
      const redirect = wellKnownStatus === 301 || wellKnownStatus === 302;
      return {
        status: wellKnown ? (redirect && !manual ? 401 : wellKnownStatus) : 401,
        statusText: "",
        url: config.url,
        headers: wellKnown && manual ? [["Location", location]] : [],
        rid: payload.rid,
      };
    }
    if (command === "plugin:http|fetch_read_body") return [1];
    throw new Error(`Unexpected IPC command: ${command}`);
  });
});

it.each([
  [301, "https://dav.example.net/calendars/", "https://dav.example.net/calendars/"],
  [302, "/dav/calendars/", "https://example.net/dav/calendars/"],
])("preserves a %i Location before DAV authentication", async (status, redirect, expected) => {
  wellKnownStatus = status;
  location = redirect;
  const result = await discoverCalDavSettings("user@example.net");
  expect(configs).toEqual([expect.objectContaining({
    url: "https://example.net/.well-known/caldav",
    method: "GET",
    maxRedirections: 0,
  })]);
  expect(result.caldavUrl).toBe(expected);
  expect(result.providerName).toBeNull();
});

it("still accepts a directly served well-known endpoint", async () => {
  wellKnownStatus = 200;
  expect((await discoverCalDavSettings("user@example.net")).caldavUrl)
    .toBe("https://example.net/.well-known/caldav");
});

it("keeps the Nextcloud OPTIONS fallback when well-known discovery fails", async () => {
  wellKnownStatus = 404;
  expect(await discoverCalDavSettings("user@example.net")).toEqual({
    providerName: "Nextcloud",
    caldavUrl: "https://example.net/remote.php/dav/",
    authMethod: "basic",
    needsAppPassword: false,
  });
  expect(configs[1]).toMatchObject({ method: "OPTIONS", url: "https://example.net/remote.php/dav/" });
});

it("returns known presets without native network calls", async () => {
  expect((await discoverCalDavSettings("user@icloud.com")).needsAppPassword).toBe(true);
  expect((await discoverCalDavSettings("user@gmail.com")).authMethod).toBe("oauth2");
  expect(configs).toEqual([]);
});
