/**
 * The app's only route — OWNED BY S5 (UI).
 *
 * Renders the mobile split view: a full-bleed MapLibre map with a draggable
 * bottom sheet on top of it. There is no top navigation by design; everything
 * lives in the sheet or floats over the map.
 *
 * This is a thin server component. All interactivity lives in
 * `components/TransitApp.tsx`, which talks to `app/api/**` and never imports
 * `lib/mock/**` directly — that is the integration seam.
 */
import { TransitApp } from "@/components/TransitApp";

export default function Page() {
  return <TransitApp />;
}
