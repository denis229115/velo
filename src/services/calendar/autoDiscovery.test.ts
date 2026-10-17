import { DAVClient } from "tsdav";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { discoverCalDavSettings, testCalDavConnection } from "./autoDiscovery";

const mockTauriFetch = vi.mocked(tauriFetch);

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

vi.mock("tsdav", () => ({
  DAVClient: vi.fn(),
}));

describe("discoverCalDavSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns Google preset for gmail.com", async () => {
    const result = await discoverCalDavSettings("user@gmail.com");
    expect(result).toEqual({
      providerName: "Google",
      caldavUrl: "https://apidata.googleusercontent.com/caldav/v2/",
      authMethod: "oauth2",
      needsAppPassword: false,
    });
  });

  it("returns iCloud preset for icloud.com with needsAppPassword", async () => {
    const result = await discoverCalDavSettings("user@icloud.com");
    expect(result).toEqual({
      providerName: "iCloud",
      caldavUrl: "https://caldav.icloud.com",
      authMethod: "basic",
      needsAppPassword: true,
    });
  });

  it("returns Fastmail preset for fastmail.com", async () => {
    const result = await discoverCalDavSettings("user@fastmail.com");
    expect(result).toEqual({
      providerName: "Fastmail",
      caldavUrl: "https://caldav.fastmail.com/",
      authMethod: "basic",
      needsAppPassword: false,
    });
  });

  it("returns Google preset with oauth2 authMethod", async () => {
    const result = await discoverCalDavSettings("user@googlemail.com");
    expect(result.authMethod).toBe("oauth2");
  });

  it("returns null caldavUrl for unknown domain with no .well-known", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("global fetch")));
    mockTauriFetch.mockRejectedValue(new Error("Network error"));

    const result = await discoverCalDavSettings("user@unknown-domain.example");
    expect(result).toEqual({
      providerName: null,
      caldavUrl: null,
      authMethod: "basic",
      needsAppPassword: false,
    });
    expect(mockTauriFetch).toHaveBeenCalled();
  });

  it("returns redirect Location for unknown domain with .well-known 301 via Tauri HTTP", async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error("global fetch"));
    vi.stubGlobal("fetch", globalFetch);
    mockTauriFetch.mockResolvedValue({
      status: 301,
      ok: false,
      headers: new Headers({
        Location: "https://caldav.unknown-domain.example/dav/",
      }),
    });

    const result = await discoverCalDavSettings("user@unknown-domain.example");
    expect(result).toEqual({
      providerName: null,
      caldavUrl: "https://caldav.unknown-domain.example/dav/",
      authMethod: "basic",
      needsAppPassword: false,
    });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("discovers Nextcloud through Tauri HTTP, not global fetch", async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error("global fetch"));
    vi.stubGlobal("fetch", globalFetch);
    mockTauriFetch.mockResolvedValue({
      status: 401,
      ok: false,
      headers: new Headers(),
    });

    const result = await discoverCalDavSettings("user@cloud.example.com");
    expect(result).toEqual({
      providerName: "Nextcloud",
      caldavUrl: "https://cloud.example.com/remote.php/dav/",
      authMethod: "basic",
      needsAppPassword: false,
    });
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("testCalDavConnection", () => {
  it("returns success with calendar count on successful connection", async () => {
    const mockLogin = vi.fn().mockResolvedValue(undefined);
    const mockFetchCalendars = vi
      .fn()
      .mockResolvedValue([{ displayName: "Personal" }, { displayName: "Work" }]);

    vi.mocked(DAVClient).mockImplementation(function () {
      return {
        login: mockLogin,
        fetchCalendars: mockFetchCalendars,
      } as unknown as InstanceType<typeof DAVClient>;
    });

    const result = await testCalDavConnection(
      "https://caldav.example.com",
      "user",
      "pass",
    );
    expect(result).toEqual({
      success: true,
      message: "Connected — found 2 calendars",
      calendarCount: 2,
    });
    expect(DAVClient).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://caldav.example.com",
        fetch: tauriFetch,
      }),
    );
  });

  it("returns failure with error message on failed connection", async () => {
    vi.mocked(DAVClient).mockImplementation(function () {
      return {
        login: vi.fn().mockRejectedValue(new Error("Invalid credentials")),
      } as unknown as InstanceType<typeof DAVClient>;
    });

    const result = await testCalDavConnection(
      "https://caldav.example.com",
      "user",
      "wrong-pass",
    );
    expect(result).toEqual({
      success: false,
      message: "Invalid credentials",
    });
  });
});
