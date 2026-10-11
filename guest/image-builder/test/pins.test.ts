import { describe, expect, it } from "vitest";
import { BASE_IMAGE, downloadFileName, GUEST_PINS, parseBaseImagePin, parseGuestPins } from "../src/pins.js";

describe("the pins in this checkout", () => {
  it("pin the base image to a dated release and a SHA-256", () => {
    expect(BASE_IMAGE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(BASE_IMAGE.url).toContain(`/release-${BASE_IMAGE.serial}/`);
    expect(BASE_IMAGE.sha256sums_url).toContain(`/release-${BASE_IMAGE.serial}/SHA256SUMS`);
    expect(BASE_IMAGE.url.endsWith(`/${BASE_IMAGE.sha256sums_entry}`)).toBe(true);
    // The name architecture section 3.2 gives the downloaded image.
    expect(BASE_IMAGE.local_name).toBe("noble-minimal-cloudimg-amd64.img");
  });

  it("pin uv and the browser layer exactly, and no Node: nothing in the guest runs it", () => {
    const tool = GUEST_PINS.uv;
    expect(tool.url).toContain(tool.version);
    expect(tool.url.endsWith(tool.shasums_entry ?? "")).toBe(true);
    expect(downloadFileName(tool)).toBe(tool.shasums_entry);
    expect(Object.keys(GUEST_PINS)).not.toContain("node");
    // The tunnel publishes no checksum list: its pinned sha256 is the only record.
    expect(GUEST_PINS.tunnel.url).toContain(`/${GUEST_PINS.tunnel.version}/`);
    expect(GUEST_PINS.tunnel.shasums_url).toBeUndefined();
    // The Python packages are pinned, with hashes, by builder/mcp-requirements.lock alone.
    expect(Object.keys(GUEST_PINS)).not.toContain("python_packages");
  });

  it("install the desktop, the browser libraries and the screenshot tool dot-agentd calls", () => {
    expect(GUEST_PINS.apt_packages).toEqual(
      expect.arrayContaining([
        "xvfb",
        "xfce4-session",
        "xfwm4",
        "dbus-x11",
        "libgtk-3-0t64",
        "libdbus-glib-1-2",
        "libasound2t64",
        // dot-agentd takes screenshots with ImageMagick's `import -window root`.
        "imagemagick",
      ]),
    );
    // Nothing talks to a guest agent: the host reaches the guest only through dot-agentd (section 5.1).
    expect(GUEST_PINS.apt_packages).not.toContain("qemu-guest-agent");
  });
});

describe("pin validation", () => {
  const good = JSON.parse(JSON.stringify(GUEST_PINS)) as Record<string, any>;

  it("rejects a hash that is not lowercase hex", () => {
    expect(() => parseGuestPins({ ...good, uv: { ...good.uv, sha256: "ABC" } })).toThrow(/uv.sha256/);
  });

  it("rejects plain http", () => {
    expect(() => parseGuestPins({ ...good, uv: { ...good.uv, url: good.uv.url.replace("https:", "http:") } })).toThrow(/not an https URL/);
  });

  it("rejects values that would need shell quoting in the guest", () => {
    expect(() => parseGuestPins({ ...good, apt_packages: ["xvfb", "x; rm -rf /"] })).toThrow(/apt_packages\[1\]/);
  });

  it("takes the packages from a pinned snapshot of the archive, and refuses one that is not a snapshot time", () => {
    expect(GUEST_PINS.apt_snapshot).toMatch(/^\d{8}T\d{6}Z$/);
    expect(() => parseGuestPins({ ...good, apt_snapshot: "latest" })).toThrow(/apt_snapshot/);
    const { apt_snapshot: _snapshot, ...unpinned } = good;
    expect(() => parseGuestPins(unpinned)).toThrow(/apt_snapshot/);
  });

  it("refuses python_packages, which would be a second copy of the lock's versions", () => {
    expect(() => parseGuestPins({ ...good, python_packages: { "invisible-playwright-mcp": "0.70.2" } })).toThrow(/mcp-requirements\.lock/);
  });

  it("rejects a base image name that is a path", () => {
    expect(() => parseBaseImagePin({ ...BASE_IMAGE, local_name: "../escape.img" })).toThrow(/local_name/);
  });
});
