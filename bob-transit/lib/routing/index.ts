/**
 * `lib/routing` barrel — offline-capable CSA router.
 *
 * The only entry point the rest of the app needs is `planJourneys`, which
 * implements the frozen `PlanJourneysFn`.
 */

export * from "./context";
export * from "./csa";
export * from "./risk-pricing";
export * from "./reliability";
export * from "./itinerary";
export * from "./plan";
