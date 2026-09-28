"use client";

/**
 * Full-bleed MapLibre GL map.
 *
 * Requirements this file is responsible for:
 *  - full-bleed: `absolute inset-0`, behind everything, no chrome of its own.
 *  - no API key: an INLINE raster style pointing at a keyless basemap, so a
 *    failed remote style fetch can never break map construction.
 *  - usable with a blank map: every overlay (network lines, stations, risk
 *    segments, the route) is local GeoJSON, so routing/results/alerts all render
 *    even when no tile ever loads. If MapLibre itself cannot start (no WebGL,
 *    offline bundle missing), we render a static fallback panel rather than
 *    throwing.
 *  - the map's bottom padding tracks the sheet detent, so "fit to route" frames
 *    the route in the part of the map the sheet is not covering.
 */
import { useEffect, useRef, useState } from "react";

// MapLibre's own stylesheet, imported here rather than in app/globals.css
// because globals.css is orchestrator-owned. Next supports importing CSS from
// node_modules inside a client component.
import "maplibre-gl/dist/maplibre-gl.css";

import type { Line, Segment, SegmentId, SegmentRisk, Station } from "@/lib/contracts";

import {
  buildEndpointFeatures,
  buildRouteFeature,
  buildSegmentFeatures,
  buildStationFeatures,
  networkBounds,
} from "@/components/lib/geo";
import { useLocale } from "@/components/LocaleProvider";

/** Keyless dark basemap. The ONLY network dependency in the app. */
const BASEMAP_TILES = [
  "https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png",
];

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

export interface MapCanvasProps {
  lines: Line[];
  stations: Station[];
  segments: Segment[];
  risks: SegmentRisk[];
  routeSegmentIds: SegmentId[];
  originStationId: string;
  destinationStationId: string;
  /** Sheet top offset in px; the map pads its bottom by this much. */
  sheetTopPx: number;
  /** Increments when the user asks to recentre on the route. */
  recentreToken: number;
}

export function MapCanvas({
  lines,
  stations,
  segments,
  risks,
  routeSegmentIds,
  originStationId,
  destinationStationId,
  sheetTopPx,
  recentreToken,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const loadedRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const { t } = useLocale();

  const segmentById = new Map(segments.map((s) => [s.id, s]));
  const stationById = new Map(stations.map((s) => [s.id, s]));

  /* ---------------- construct the map once ---------------- */
  useEffect(() => {
    let cancelled = false;
    let map: import("maplibre-gl").Map | null = null;

    async function start() {
      const container = containerRef.current;
      if (!container) return;
      try {
        const mod = await import("maplibre-gl");
        if (cancelled) return;
        const { Map: MapLibreMap } = mod;

        map = new MapLibreMap({
          container,
          // Inline style: no remote style.json fetch, so a network failure
          // degrades to blank tiles rather than a broken map.
          style: {
            version: 8,
            sources: {
              basemap: {
                type: "raster",
                tiles: BASEMAP_TILES,
                tileSize: 256,
                attribution: ATTRIBUTION,
                maxzoom: 19,
              },
            },
            layers: [
              {
                id: "background",
                type: "background",
                paint: { "background-color": "#0b0f14" },
              },
              {
                id: "basemap",
                type: "raster",
                source: "basemap",
                paint: { "raster-opacity": 0.72, "raster-saturation": -0.35 },
              },
            ],
          },
          center: [101.6869, 3.139],
          zoom: 10.6,
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          renderWorldCopies: false,
        });

        mapRef.current = map;

        map.on("load", () => {
          if (!map || cancelled) return;
          loadedRef.current = true;
          setStatus("ready");

          map.addSource("network", { type: "geojson", data: EMPTY_FC });
          map.addSource("risk", { type: "geojson", data: EMPTY_FC });
          map.addSource("route", { type: "geojson", data: EMPTY_FC });
          map.addSource("stations", { type: "geojson", data: EMPTY_FC });
          map.addSource("endpoints", { type: "geojson", data: EMPTY_FC });

          map.addLayer({
            id: "network-casing",
            type: "line",
            source: "network",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#0b0f14",
              "line-width": ["interpolate", ["linear"], ["zoom"], 9, 3.5, 14, 8],
              "line-opacity": 0.9,
            },
          });
          map.addLayer({
            id: "network-line",
            type: "line",
            source: "network",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ["get", "color"],
              "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.8, 14, 4.5],
              "line-opacity": 0.9,
            },
          });
          // Risk segments: colour AND width encode probability, so risk is not
          // carried by hue alone (colour-blind safe, and legible over a dark map).
          map.addLayer({
            id: "risk-line",
            type: "line",
            source: "risk",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": [
                "interpolate",
                ["linear"],
                ["get", "probability"],
                0.2,
                "#fbbf24",
                0.5,
                "#fb923c",
                0.8,
                "#ef4444",
              ],
              "line-width": [
                "interpolate",
                ["linear"],
                ["get", "probability"],
                0.2,
                5,
                0.5,
                7,
                0.9,
                9,
              ],
              "line-opacity": 0.95,
            },
          });
          map.addLayer({
            id: "route-casing",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#020617",
              "line-width": ["interpolate", ["linear"], ["zoom"], 9, 8, 14, 14],
              "line-opacity": 0.85,
            },
          });
          map.addLayer({
            id: "route-line",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#f8fafc",
              "line-width": ["interpolate", ["linear"], ["zoom"], 9, 4, 14, 7],
            },
          });
          map.addLayer({
            id: "station-dots",
            type: "circle",
            source: "stations",
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                ["case", ["get", "isInterchange"], 2.6, 1.5],
                14,
                ["case", ["get", "isInterchange"], 6, 3.5],
              ],
              "circle-color": "#0f172a",
              "circle-stroke-color": "#e2e8f0",
              "circle-stroke-width": ["case", ["get", "isInterchange"], 1.8, 1],
            },
          });
          map.addLayer({
            id: "endpoint-halo",
            type: "circle",
            source: "endpoints",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 7, 14, 13],
              "circle-color": [
                "match",
                ["get", "role"],
                "origin",
                "#22d3ee",
                "destination",
                "#a3e635",
                "#94a3b8",
              ],
              "circle-opacity": 0.28,
            },
          });
          map.addLayer({
            id: "endpoint-dot",
            type: "circle",
            source: "endpoints",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3.6, 14, 7],
              "circle-color": [
                "match",
                ["get", "role"],
                "origin",
                "#22d3ee",
                "destination",
                "#a3e635",
                "#94a3b8",
              ],
              "circle-stroke-color": "#020617",
              "circle-stroke-width": 2,
            },
          });
        });

        map.on("error", () => {
          // Tile and glyph failures are expected offline; never let them take
          // the app down. The overlays keep rendering from local data.
        });
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    }

    void start();

    return () => {
      cancelled = true;
      loadedRef.current = false;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  /* ---------------- push data into the sources ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    const riskMap = new Map<SegmentId, SegmentRisk>(risks.map((r) => [r.segmentId, r]));
    const riskSegments = segments.filter((s) => riskMap.has(s.id));

    setData(map, "network", buildSegmentFeatures(segments, lines, riskMap));
    setData(map, "risk", buildSegmentFeatures(riskSegments, lines, riskMap));
    setData(map, "stations", buildStationFeatures(stations));
    setData(
      map,
      "route",
      buildRouteFeature(routeSegmentIds, segmentById, "#f8fafc"),
    );
    setData(
      map,
      "endpoints",
      buildEndpointFeatures(
        stationById.get(originStationId),
        stationById.get(destinationStationId),
      ),
    );

    const bounds = networkBounds(segments);
    if (bounds && routeSegmentIds.length === 0) {
      map.fitBounds(bounds, { padding: 36, duration: 0, maxZoom: 12 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, stations, segments, risks, routeSegmentIds.join("|"), originStationId, destinationStationId]);

  /* ---------------- frame the route in the uncovered area ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const coords: Array<[number, number]> = [];
    for (const segmentId of routeSegmentIds) {
      const segment = segmentById.get(segmentId);
      if (!segment) continue;
      for (const point of segment.shape) coords.push([point.lon, point.lat]);
    }
    if (coords.length === 0) return;

    let west = coords[0][0];
    let east = coords[0][0];
    let south = coords[0][1];
    let north = coords[0][1];
    for (const [lon, lat] of coords) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      {
        padding: { top: 96, bottom: sheetTopPx + 24, left: 36, right: 36 },
        duration: 0,
        maxZoom: 14,
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentreToken, routeSegmentIds.join("|")]);

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        data-testid="map-canvas"
        aria-label={t("map.legend")}
        className="absolute inset-0"
      />
      {status === "unavailable" ? (
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-[18vh]">
          <p className="mx-6 rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 text-center text-xs text-slate-300 backdrop-blur">
            {t("map.unavailable")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** `setData` is typed loosely by MapLibre; keep the cast in one place. */
function setData(
  map: import("maplibre-gl").Map,
  sourceId: string,
  data: unknown,
): void {
  const source = map.getSource(sourceId);
  if (source && "setData" in source && typeof source.setData === "function") {
    (source as { setData: (next: unknown) => void }).setData(data);
  }
}
