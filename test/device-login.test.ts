import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DroplApiClient } from "../src/api-client.js";
import { browserCommand } from "../src/browser.js";
import { runCli, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../src/commands.js";
import { DeviceLoginError, runDeviceLogin } from "../src/device-login.js";
import { makeTempDirectory, removeDirectory } from "./helpers/fixtures.js";
import { ISSUED_API_KEY, MockDroplApi } from "./helpers/mock-api.js";

const MS_PER_SECOND = 1000;

function fakeClock() {
  let current = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
  };
}

describe("device sign-in", () => {
  let api: MockDroplApi;
  beforeEach(async () => {
    api = new MockDroplApi();
    await api.start();
  });
  afterEach(() => api.stop());

  it("polls through pending and slow_down, then returns the key", async () => {
    api.deviceScript = ["pending", "slow_down", "pending", "success"];
    const clock = fakeClock();
    const lines: string[] = [];
    const opened: string[] = [];
    const token = await runDeviceLogin({
      client: new DroplApiClient({ apiUrl: api.baseUrl }),
      clientName: "Cursor",
      deviceName: `  ${"laptop".repeat(20)}  `,
      openBrowser: (url) => {
        opened.push(url);
        return true;
      },
      print: (line) => lines.push(line),
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(token.access_token).toBe(ISSUED_API_KEY);
    expect(clock.sleeps).toEqual([5, 5, 10, 10].map((seconds) => seconds * MS_PER_SECOND));
    expect(opened).toEqual([`${api.origin}/connect?code=BCDF-GHJK`]);
    expect(lines.join("\n")).toContain("BCDF-GHJK");
    const [authorization] = api.requestsTo("POST", /^\/v1\/auth\/device$/);
    expect(authorization!.body.client_name).toBe("Cursor");
    expect(authorization!.body.device_name).toHaveLength(60);
    expect(authorization!.headers.authorization).toBeUndefined();
    const [tokenRequest] = api.requestsTo("POST", /^\/v1\/auth\/device\/token$/);
    expect(tokenRequest!.body).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "device-code-1" });
  });

  it("stops when the user denies", async () => {
    api.deviceScript = ["pending", "denied"];
    const clock = fakeClock();
    await expect(
      runDeviceLogin({ client: new DroplApiClient({ apiUrl: api.baseUrl }), openBrowser: null, print: () => undefined, sleep: clock.sleep, now: clock.now }),
    ).rejects.toMatchObject({ reason: "denied" });
  });

  it("stops when the server says the code expired", async () => {
    api.deviceScript = ["expired"];
    const clock = fakeClock();
    await expect(
      runDeviceLogin({ client: new DroplApiClient({ apiUrl: api.baseUrl }), openBrowser: null, print: () => undefined, sleep: clock.sleep, now: clock.now }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("stops polling at expires_in", async () => {
    api.deviceScript = [];
    api.deviceExpiresIn = 12;
    const clock = fakeClock();
    const error = await runDeviceLogin({
      client: new DroplApiClient({ apiUrl: api.baseUrl }),
      openBrowser: null,
      print: () => undefined,
      sleep: clock.sleep,
      now: clock.now,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeviceLoginError);
    expect((error as DeviceLoginError).reason).toBe("expired");
    expect(api.requestsTo("POST", /token$/)).toHaveLength(2);
  });
});

describe("browser launch", () => {
  it("uses an argument array per platform and refuses unsafe URLs for cmd", () => {
    expect(browserCommand("https://www.dropl.io/connect?code=BCDF-GHJK", "darwin")).toEqual({ command: "open", args: ["https://www.dropl.io/connect?code=BCDF-GHJK"] });
    expect(browserCommand("https://www.dropl.io/connect?code=BCDF-GHJK", "linux")).toEqual({ command: "xdg-open", args: ["https://www.dropl.io/connect?code=BCDF-GHJK"] });
    expect(browserCommand("https://www.dropl.io/connect?code=BCDF-GHJK", "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", "https://www.dropl.io/connect?code=BCDF-GHJK"] });
    expect(browserCommand("https://www.dropl.io/connect?a=1&calc.exe", "win32")).toBeNull();
    expect(browserCommand("http://evil.example/connect", "darwin")).toBeNull();
    expect(browserCommand("file:///etc/passwd", "linux")).toBeNull();
  });
});

describe("CLI", () => {
  let api: MockDroplApi;
  let home: string;
  beforeEach(async () => {
    api = new MockDroplApi();
    await api.start();
    home = await makeTempDirectory();
  });
  afterEach(async () => {
    await api.stop();
    await removeDirectory(home);
  });

  function environment(env: NodeJS.ProcessEnv = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const clock = fakeClock();
    let serverStarted = false;
    return {
      stdout,
      stderr,
      get serverStarted() {
        return serverStarted;
      },
      cli: {
        platform: { env: { XDG_CONFIG_HOME: path.join(home, "config"), ...env }, platform: process.platform, homeDirectory: home },
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
        startServer: async () => {
          serverStarted = true;
        },
        sleep: clock.sleep,
        now: clock.now,
        openBrowser: () => false,
        hostname: () => "studio-laptop",
      },
    };
  }

  it("logs in, saves a private profile, and never prints the full key", async () => {
    api.deviceScript = ["pending", "success"];
    const run = environment();
    const exitCode = await runCli(["login", "--api-url", api.baseUrl, "--client", "Cursor", "--no-browser"], run.cli);
    expect(exitCode).toBe(EXIT_OK);
    const output = run.stdout.join("\n");
    expect(output).toContain("Connected to Acme Studio as Cursor on laptop");
    expect(output).not.toContain(ISSUED_API_KEY);

    const filePath = path.join(home, "config", "dropl", "credentials.json");
    const saved = JSON.parse(await readFile(filePath, "utf8"));
    expect(saved.profiles[api.baseUrl]).toMatchObject({ apiKey: ISSUED_API_KEY, keyName: "Cursor on laptop", organization: { id: "org1", name: "Acme Studio" } });
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(api.requestsTo("POST", /^\/v1\/auth\/device$/)[0]!.body).toMatchObject({ client_name: "Cursor", device_name: "studio-laptop" });

    const whoami = environment();
    expect(await runCli(["whoami", "--api-url", api.baseUrl], whoami.cli)).toBe(EXIT_OK);
    expect(whoami.stdout.join("\n")).toContain("Account: Acme Studio");

    const logout = environment();
    expect(await runCli(["logout", "--api-url", api.baseUrl], logout.cli)).toBe(EXIT_OK);
    expect(logout.stdout.join("\n")).toContain("Settings → API keys");
    const afterLogout = JSON.parse(await readFile(filePath, "utf8"));
    expect(afterLogout.profiles[api.baseUrl]).toBeUndefined();
  });

  it("refuses a plain-http API URL that isn't localhost", async () => {
    const run = environment();
    expect(await runCli(["login", "--api-url", "http://dropl.example.com/api"], run.cli)).toBe(EXIT_FAILURE);
    expect(run.stderr.join("\n")).toContain("https");
  });

  it("starts the server with no arguments and handles help, version and unknown commands", async () => {
    const serve = environment();
    expect(await runCli([], serve.cli)).toBe(EXIT_OK);
    expect(serve.serverStarted).toBe(true);
    const help = environment();
    expect(await runCli(["--help"], help.cli)).toBe(EXIT_OK);
    expect(help.stdout.join("\n")).toContain("dropl-mcp login");
    const version = environment();
    expect(await runCli(["--version"], version.cli)).toBe(EXIT_OK);
    expect(version.stdout[0]).toMatch(/^\d+\.\d+\.\d+/);
    const unknown = environment();
    expect(await runCli(["upload"], unknown.cli)).toBe(EXIT_USAGE);
  });
});
