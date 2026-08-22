import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LogoField } from "./LogoField";

function png(name: string, bytes: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function arm() {
  const checkbox = screen.getByRole("checkbox", { name: /moderated/i });
  fireEvent.click(checkbox);
  return checkbox;
}

describe("LogoField", () => {
  beforeEach(() => {
    // jsdom has no real object-URL implementation.
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:mock-url"), revokeObjectURL: vi.fn() }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables the file picker until the moderation checkbox is checked", async () => {
    render(<LogoField value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText(/logo image/i);
    expect(input).toBeDisabled();

    arm();
    expect(input).not.toBeDisabled();
  });

  it("uploads a valid image, shows a preview and calls onChange with the pinned ipfs uri", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ uri: "ipfs://cid123", cid: "cid123", gatewayUrl: "https://gw.example/ipfs/cid123" }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const onChange = vi.fn();
    const onUploading = vi.fn();
    render(<LogoField value="" onChange={onChange} onUploading={onUploading} />);

    arm();
    const input = screen.getByLabelText(/logo image/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [png("logo.png")] } });

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("ipfs://cid123"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/pin");
    expect(init?.headers).toMatchObject({ "content-type": "image/png" });

    expect(onUploading.mock.calls[0]).toEqual([true]);
    expect(onUploading.mock.calls.at(-1)).toEqual([false]);

    const preview = await screen.findByRole("img");
    expect(preview).toHaveAttribute("src", "https://gw.example/ipfs/cid123");
  });

  it("rejects a mistyped file: clears value, shows an error, and leaves no stale preview", async () => {
    const onChange = vi.fn();
    render(<LogoField value="" onChange={onChange} />);

    arm();
    const input = screen.getByLabelText(/logo image/i);
    const badFile = new File(["not an image"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [badFile] } });

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
    expect(screen.getByText(/png, jpeg, webp or gif/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("rejects an oversized file: clears value, shows an error, and leaves no stale preview", async () => {
    const onChange = vi.fn();
    render(<LogoField value="" onChange={onChange} />);

    arm();
    const input = screen.getByLabelText(/logo image/i);
    const bigFile = png("huge.png", new Array(5 * 1024 * 1024 + 1).fill(1));
    fireEvent.change(input, { target: { files: [bigFile] } });

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
    expect(screen.getByText(/smaller than 5 mb/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("clears value and preview together when a failed upload follows a good preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Pinata pin failed: 500" }), { status: 502 }))
    );

    const onChange = vi.fn();
    const onUploading = vi.fn();
    render(<LogoField value="" onChange={onChange} onUploading={onUploading} />);

    arm();
    const input = screen.getByLabelText(/logo image/i);
    fireEvent.change(input, { target: { files: [png("logo.png")] } });

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(onUploading.mock.calls[0]).toEqual([true]);
    expect(onUploading.mock.calls.at(-1)).toEqual([false]);
  });
});
