import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

function readText(relativePath: string): string {
  return readFileSync(resolve(PUBLIC_DIR, relativePath), "utf8");
}

function readBytes(relativePath: string): Buffer {
  return readFileSync(resolve(PUBLIC_DIR, relativePath));
}

interface PngInfo {
  signature: string;
  width: number;
  height: number;
}

/** Parse the 8-byte PNG signature and the IHDR width/height. */
function inspectPng(bytes: Buffer): PngInfo {
  const signature = bytes.subarray(0, 8).toString("hex");
  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.subarray(12, 16).toString("ascii");
  expect(ihdrLength).toBe(13);
  expect(ihdrType).toBe("IHDR");
  return {
    signature,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface WebManifest {
  name: string;
  short_name: string;
  display: string;
  start_url: string;
  scope?: string;
  theme_color: string;
  background_color: string;
  icons: WebManifestIcon[];
}

const manifest = JSON.parse(readText("manifest.webmanifest")) as WebManifest;

describe("manifest.webmanifest", () => {
  it("is a valid, installable web app manifest", () => {
    expect(manifest.name).toBe("Klang Valley Transit Reliability");
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
  });

  it("declares 192x192 and 512x512 icons plus a maskable one", () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    const maskable = manifest.icons.filter((icon) => icon.purpose?.includes("maskable"));
    expect(maskable.length).toBeGreaterThanOrEqual(1);
    expect(maskable[0].sizes).toBe("512x512");
  });
});

describe("PWA icons", () => {
  const PNG_SIGNATURE = "89504e470d0a1a0a";

  it("are real PNG files with the dimensions the manifest declares", () => {
    for (const icon of manifest.icons) {
      const bytes = readBytes(icon.src.replace(/^\//, ""));
      expect(bytes.length).toBeGreaterThan(1000);
      const info = inspectPng(bytes);
      expect(info.signature, `${icon.src} must start with the PNG signature`).toBe(PNG_SIGNATURE);
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(info.width, `${icon.src} width`).toBe(width);
      expect(info.height, `${icon.src} height`).toBe(height);
    }
  });

  it("ships the 192 and 512 icons the acceptance criteria name", () => {
    const expected = [
      ["icons/icon-192.png", 192],
      ["icons/icon-512.png", 512],
      ["icons/icon-maskable-512.png", 512],
    ] as const;
    for (const [file, size] of expected) {
      expect(statSync(`${PUBLIC_DIR}${file}`).size).toBeGreaterThan(0);
      const info = inspectPng(readBytes(file));
      expect(info.signature).toBe(PNG_SIGNATURE);
      expect(info.width).toBe(size);
      expect(info.height).toBe(size);
    }
  });

  it("does not ship a text file pretending to be a PNG", () => {
    const bytes = readBytes("icons/icon-192.png");
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(bytes.subarray(4, 8).toString("hex")).toBe("0d0a1a0a");
  });
});

describe("service worker", () => {
  const source = readText("sw.js");

  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it("precaches the app shell and an offline fallback", () => {
    expect(source).toContain('addEventListener("install"');
    expect(source).toContain("PRECACHE_URLS");
    expect(source).toContain('"/offline.html"');
    expect(source).toContain("caches.open(SHELL_CACHE)");
    expect(source).toContain("skipWaiting");
  });

  it("uses cache-first for the transit graph JSON", () => {
    expect(source).toContain("GRAPH_PATH_PREFIX");
    expect(source).toContain('"/graph/"');
    expect(source).toContain("cacheFirst(request, GRAPH_CACHE)");
  });

  it("uses stale-while-revalidate for API responses", () => {
    expect(source).toContain("staleWhileRevalidate(request, API_CACHE)");
    expect(source).toContain('url.pathname.startsWith("/api/")');
  });

  it("falls back to the cached shell when a navigation exceeds the network budget", () => {
    expect(source).toContain("NAVIGATION_NETWORK_BUDGET_MS");
    expect(source).toContain('request.mode === "navigate"');
    expect(source).toContain("OFFLINE_NO_CACHE");
  });

  it("only intercepts same-origin GETs", () => {
    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain("isSameOrigin(url)");
  });

  it("drops caches from older versions on activate", () => {
    expect(source).toContain('addEventListener("activate"');
    expect(source).toContain("caches.delete(name)");
  });

  it("keeps the cold-start critical path small enough for throttled 4G", () => {
    // The precache list is the only thing fetched during install; keep it tiny.
    const precacheBlock = source.slice(
      source.indexOf("const PRECACHE_URLS"),
      source.indexOf("];", source.indexOf("const PRECACHE_URLS")),
    );
    const urls = precacheBlock.match(/"[^"]+"/g) ?? [];
    expect(urls.length).toBeLessThanOrEqual(8);

    // A navigation may wait at most 5s on the network before the cached shell wins.
    const budget = Number(source.match(/NAVIGATION_NETWORK_BUDGET_MS = (\d+)/)?.[1]);
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeLessThanOrEqual(5000);

    // Repeat visits never block on the API: cache first, revalidate behind it.
    const swr = source.slice(
      source.indexOf("async function staleWhileRevalidate"),
      source.indexOf("async function handleNavigation"),
    );
    expect(swr.indexOf("if (cached)")).toBeLessThan(swr.indexOf("const response = await network"));
  });
});

describe("offline fallback page", () => {
  it("exists, is self-contained and links the manifest", () => {
    const html = readText("offline.html");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain("/icons/icon-192.png");
    expect(html.toLowerCase()).toContain("offline");
  });
});
