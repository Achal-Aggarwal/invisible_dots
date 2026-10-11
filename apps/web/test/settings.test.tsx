// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStreamProvider } from "../src/components/events";
import { HostSettings } from "../src/components/settings/HostSettings";
import { AttentionProvider, useHealth } from "../src/components/shell/attention";
import { THEME_KEY } from "../src/lib/theme";
import { stubMatchMedia } from "./support/browser";
import { FakeControlPlane } from "./support/control-plane";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.install();
  stubMatchMedia();
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** What the shell's rail reads from the same health answer, to see that the page and the rail agree. */
function RailKey() {
  const health = useHealth();
  return <p data-testid="rail-key">{health.data ? String(health.data.openrouter_configured) : "unknown"}</p>;
}

async function renderSettings() {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <HostSettings />
        <RailKey />
      </AttentionProvider>
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { name: "Settings" });
}

const section = (name: string) => screen.getByRole("region", { name });

/** The line of the checks for one item, as a screen reader hears it. */
function checkLine(label: string): string {
  const line = within(section("Host checks")).getAllByRole("listitem").find((item) => item.textContent?.startsWith(label));
  if (!line) throw new Error(`no check named ${label}`);
  return line.textContent ?? "";
}

describe("Settings: host checks", () => {
  it("lists the checks of the control plane and of the host, and says when everything is in place", async () => {
    await renderSettings();
    await waitFor(() => expect(within(section("Host checks")).getAllByRole("listitem")).toHaveLength(6));
    expect(checkLine("Control plane")).toBe("Control plane: ReadyAnswering, version 9.9.9.");
    expect(checkLine("QEMU")).toBe("QEMU: Ready8.2.2");
    expect(within(section("Host checks")).getByText("Everything a Dot needs is in place.")).toBeTruthy();
  });

  it("shows what is missing with the command that fixes it, a button that copies it, and how many things need attention", async () => {
    plane.doctor = [
      { id: "qemu", label: "QEMU", status: "missing", detail: "not found on PATH", fix: "invisible-dots setup" },
      { id: "golden-image", label: "golden image", status: "missing", detail: "none in the images folder", fix: "invisible-dots image build" },
    ];
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await renderSettings();
    await waitFor(() => expect(within(section("Host checks")).getAllByRole("listitem")).toHaveLength(5));
    expect(checkLine("QEMU")).toBe("QEMU: Needs attentionnot found on PATHFix: invisible-dots setup");
    expect(within(section("Host checks")).getByText(/2 things need attention/)).toBeTruthy();

    await userEvent.click(within(section("Host checks")).getByRole("button", { name: "Copy the fix for golden image" }));
    expect(writeText).toHaveBeenCalledWith("invisible-dots image build");
    expect(await within(section("Host checks")).findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("checks again on request, and by itself when the person comes back to the window while something is missing", async () => {
    plane.doctor = [{ id: "qemu", label: "QEMU", status: "missing", detail: "not found on PATH", fix: "invisible-dots setup" }];
    await renderSettings();
    await waitFor(() => expect(checkLine("QEMU")).toContain("Needs attention"));
    const asked = () => plane.requests.filter((request) => request === "GET /api/doctor").length;
    expect(asked()).toBe(1);

    // The person ran the command in a terminal and returns to this window.
    plane.doctor = [{ id: "qemu", label: "QEMU", status: "ok", detail: "8.2.2" }];
    act(() => {
      fireEvent.focus(window);
    });
    await waitFor(() => expect(checkLine("QEMU")).toBe("QEMU: Ready8.2.2"));
    expect(asked()).toBe(2);

    // Nothing is missing any more, so coming back asks nothing.
    act(() => {
      fireEvent.focus(window);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked()).toBe(2);

    await userEvent.click(within(section("Host checks")).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(asked()).toBe(3));
  });

  it("says that the host was not checked when the report cannot be made", async () => {
    plane.failDoctor = 500;
    await renderSettings();
    await waitFor(() => expect(checkLine("This computer")).toBe("This computer: Not checkedNot checked: the doctor could not run"));
  });
});

describe("Settings: the OpenRouter key", () => {
  const keyField = () => screen.getByLabelText(/^(OpenRouter API key|Replace the key)$/) as HTMLInputElement;

  it("is a write-only field, and says whether a key is stored from the health answer", async () => {
    plane.keyConfigured = false;
    await renderSettings();
    await waitFor(() => expect(within(section("OpenRouter key")).getByText("No key is stored.")).toBeTruthy());
    expect(keyField().type).toBe("password");
    expect(keyField().autocomplete).toBe("off");
    expect((screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the key, says how many running Dots got it, empties the field and tells the rest of the page", async () => {
    plane.keyConfigured = false;
    plane.keyPushedTo = 2;
    await renderSettings();
    await waitFor(() => expect(screen.getByTestId("rail-key").textContent).toBe("false"));
    await userEvent.type(keyField(), "  sk-or-v1-abcdef  ");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("Saved. Pushed to 2 running Dots.")).toBeTruthy();
    expect(plane.savedKeys).toEqual(["sk-or-v1-abcdef"]);
    // The field is emptied and the key is nowhere on the page: it is write-only.
    expect(keyField().value).toBe("");
    expect(document.body.textContent).not.toContain("sk-or-v1-abcdef");
    // The shared health answer was asked again, so the rail, the checklist and this form agree at once.
    await waitFor(() => expect(screen.getByTestId("rail-key").textContent).toBe("true"));
    await waitFor(() => expect(within(section("OpenRouter key")).getByText("A key is stored.")).toBeTruthy());
    await waitFor(() => expect(checkLine("OpenRouter key")).toBe("OpenRouter key: ReadyStored."));
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy();
  });

  it("says nothing was pushed when no computer is running", async () => {
    plane.keyConfigured = false;
    await renderSettings();
    await userEvent.type(keyField(), "sk-or-first");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("Saved. No Dot's computer is running, so each gets the key when it starts.")).toBeTruthy();
  });

  it("refuses a key with a space inside before it is sent", async () => {
    await renderSettings();
    await userEvent.type(keyField(), "sk or key");
    await userEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(await screen.findByText(/must be printable ASCII without spaces/)).toBeTruthy();
    expect(keyField().getAttribute("aria-invalid")).toBe("true");
    expect(plane.savedKeys).toEqual([]);
    // Typing again clears the complaint.
    await userEvent.type(keyField(), "x");
    expect(keyField().getAttribute("aria-invalid")).toBeNull();
  });

  it("shows the control plane's refusal and keeps what was typed", async () => {
    plane.failKey = { status: 503, error: "database_unavailable", message: "the database did not answer" };
    await renderSettings();
    await userEvent.type(keyField(), "sk-or-keep");
    await userEvent.click(screen.getByRole("button", { name: "Replace key" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not save the key");
    expect(alert.textContent).toContain("the database did not answer");
    expect(keyField().value).toBe("sk-or-keep");
    expect(screen.queryByText(/^Saved\./)).toBeNull();
  });
});

describe("Settings: appearance and about", () => {
  it("chooses the theme, applies it at once and keeps it in this browser", async () => {
    await renderSettings();
    expect((screen.getByRole("radio", { name: /System/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect((screen.getByRole("radio", { name: /Dark/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: /Light/ }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("lists the version, the database and where the data and the logs are", async () => {
    await renderSettings();
    const about = await screen.findByRole("region", { name: "About" });
    await waitFor(() => expect(within(about).getByText("9.9.9")).toBeTruthy());
    expect(within(about).getByText("Embedded PostgreSQL (PGlite), inside the server")).toBeTruthy();
    expect(within(about).getByText("/home/me/.invisible-dots")).toBeTruthy();
    expect(within(about).getByText("/home/me/.invisible-dots/logs")).toBeTruthy();
    expect(within(about).getByText("invisible-dots logs <dot>")).toBeTruthy();
  });

  it("says when the control plane does not answer", async () => {
    plane.healthy = false;
    await renderSettings();
    const about = await screen.findByRole("region", { name: "About" });
    expect((await within(about).findByRole("alert")).textContent).toContain("The control plane does not answer");
  });
});
