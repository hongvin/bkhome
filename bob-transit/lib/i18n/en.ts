/**
 * English (source of truth) dictionary.
 *
 * `en` is the canonical key set: `TranslationKey` is derived from it and the
 * Bahasa Malaysia dictionary is typed as a complete `Record<TranslationKey, string>`,
 * so a missing BM key is a compile error *and* a failing test (tests/ui/i18n.test.ts).
 */
export const en = {
  /* ---- app ---- */
  "app.name": "Reliability",
  "app.tagline": "Arrival probability, not average time",

  /* ---- search / peek ---- */
  "search.from": "From",
  "search.to": "To",
  "search.pickOrigin": "Starting station",
  "search.pickDestination": "Destination station",
  "search.swap": "Swap origin and destination",
  "search.cta": "Find reliable route",
  "search.ctaShort": "Go",
  "search.searchPlaceholder": "Search station",
  "search.noResults": "No station matches",
  "search.clear": "Clear",
  "search.interchange": "Interchange",
  "search.accessible": "Step-free access",
  "search.lines": "Lines",
  "search.popular": "Common trips",

  /* ---- sheet ---- */
  "sheet.handle": "Route panel",
  "sheet.expand": "Expand route panel",
  "sheet.collapse": "Collapse route panel",
  "sheet.detent.peek": "Collapsed",
  "sheet.detent.half": "Half",
  "sheet.detent.full": "Full",
  "sheet.resizeHint": "Drag to resize",

  /* ---- results ---- */
  "results.title": "Routes",
  "results.count": "{count} options",
  "results.countOne": "1 option",
  "results.rank": "Option {rank}",
  "results.topOption": "Best reliability",
  "results.whyThisRank": "Why this rank",
  "results.whyTop": "Why this is the top option",
  "results.typical": "Typical",
  "results.p90": "P90",
  "results.p90Label": "90% of trips arrive by {time}",
  "results.window": "{p50} – {p90}",
  "results.expectedDelay": "+{min} min expected delay",
  "results.onTime": "No expected delay",
  "results.transfers": "{count} transfers",
  "results.transfersOne": "1 transfer",
  "results.transfersNone": "No transfer",
  "results.lines": "{count} lines",
  "results.risk": "Risk",
  "results.noRisk": "No known risk",
  "results.empty": "No route found for this pair",
  "results.noSafeAlternative":
    "No fully safe option — every route crosses a confirmed disruption",
  "results.fallback": "Ground transport",
  "results.fallbackNote": "Suggested alternative while the network recovers",
  "results.select": "Use this route",
  "results.selected": "Selected",
  "results.computedOffline": "Computed offline from saved data",
  "results.whyWrong": "Most likely reason this is wrong",

  /* ---- rank explanations ---- */
  "why.saferThanFaster":
    "Slower than the fastest option by {delta} min, but it avoids the confirmed disruption that route crosses.",
  "why.clean": "No known disruption on any segment of this route.",
  "why.mostReliable": "The highest reliability of the {count} options on this trip.",
  "why.lowerRisk":
    "This route crosses a {severity} {issue} at {pct}% confidence, so it ranks lower.",
  "why.lowerScore": "Less reliable than the options above it.",
  "why.riskOnBoard": "{severity} {issue} on this route, {pct}% confidence.",
  "why.delayAdded": "About {min} min of expected delay.",
  "why.slowerThanFastest": "{delta} min slower than the fastest option.",
  "why.fastestOption": "The fastest option, but not the most reliable.",

  /* ---- reliability badges ---- */
  "badge.VERY_RELIABLE": "Very reliable",
  "badge.RELIABLE": "Reliable",
  "badge.UNCERTAIN": "Uncertain",
  "badge.AT_RISK": "At risk",
  "badge.AVOID": "Avoid",

  /* ---- severity ---- */
  "severity.INFO": "Info",
  "severity.MINOR": "Minor",
  "severity.MAJOR": "Major",
  "severity.SEVERE": "Severe",

  /* ---- issue types ---- */
  "issue.TRACK_FAULT": "Track fault",
  "issue.SIGNAL_FAULT": "Signal fault",
  "issue.VEHICLE_BREAKDOWN": "Train breakdown",
  "issue.ELEVATOR_FAULT": "Lift fault",
  "issue.DOOR_FAULT": "Door fault",
  "issue.CROWDING": "Crowding",
  "issue.DELAY": "Delay",
  "issue.ROAD_BLOCKED": "Road blocked",
  "issue.WEATHER": "Weather",
  "issue.UNKNOWN": "Unconfirmed report",

  /* ---- signal status ---- */
  "status.CANDIDATE": "Unverified report",
  "status.REPORTED": "Reported",
  "status.CONFIRMED": "Confirmed",
  "status.CLEARED": "Cleared",
  "status.REJECTED": "Rejected",

  /* ---- disruption card ---- */
  "alert.title": "Disruption",
  "alert.titlePlural": "Disruptions",
  "alert.what": "What",
  "alert.where": "Where",
  "alert.severity": "Severity",
  "alert.confidence": "Confidence",
  "alert.sources": "Sources",
  "alert.sourcesOfficial": "{count} official",
  "alert.sourcesSocial": "{count} distinct people",
  "alert.sourcesRealtime": "{count} live observations",
  "alert.lead": "Lead time",
  "alert.leadTime": "{min} min before the operator",
  "alert.leadTimeNone": "Operator has not acknowledged this yet",
  "alert.firstSeen": "First seen",
  "alert.operatorNotified": "Operator notified",
  "alert.notNotified": "Not yet notified",
  "alert.window": "Window",
  "alert.reasoning": "Assessment",
  "alert.humanCheck": "A human would check this",
  "alert.unresolved": "Location not pinpointed",
  "alert.candidates": "{count} possible segments",
  "alert.explain": "Why do we believe this?",
  "alert.ongoing": "Ongoing",
  "alert.none": "No active disruptions",
  "alert.noneBody": "Nothing is currently affecting the network we can see.",
  "alert.affectsYourRoute": "On your route",
  "alert.segment": "Segment",
  "alert.line": "Line",

  /* ---- source inspector ---- */
  "source.title": "Why we believe this",
  "source.claim": "Claim",
  "source.steps": "How we got here",
  "source.confidenceByHop": "Confidence at each step",
  "source.hop.INGEST": "Ingest",
  "source.hop.VERIFY": "Verify",
  "source.hop.IMPACT": "Impact",
  "source.hop.ADVISORY": "Advisory",
  "source.refs": "Rests on",
  "source.routeDecision": "How this changed your route",
  "source.routeDecisionBody":
    "This signal added {delay} min of expected delay to option {rank}, which is why it is ranked below the safer route.",
  "source.routeDecisionNone":
    "This signal did not change the ranking of the routes we returned.",
  "source.back": "Back",
  "source.close": "Close",
  "source.rawText": "Source text",
  "source.openSource": "Open original",
  "source.author": "Posted by",
  "source.published": "Published",
  "source.language": "Language",
  "source.noTrace": "No explanation is available for this item",
  "source.stepConfidence": "{pct}% confident",

  /* ---- confidence bands ---- */
  "confidence.VERY_LOW": "Very low",
  "confidence.LOW": "Low",
  "confidence.MODERATE": "Moderate",
  "confidence.HIGH": "High",
  "confidence.VERY_HIGH": "Very high",
  "confidence.reducedOffline": "Reduced — offline cache",

  /* ---- staleness / offline ---- */
  "stale.asOf": "as of {time}, {min} min ago",
  "stale.asOfJustNow": "as of {time}, less than a minute ago",
  "stale.asOfHours": "as of {time}, {h} h {m} min ago",
  "stale.live": "Live",
  "stale.cached": "Saved data",
  "offline.offline": "Offline",
  "offline.banner": "You are offline — showing saved data",
  "offline.confidenceReduced": "Risk confidence is reduced while offline",
  "offline.retry": "Retry",
  "offline.stillWorks": "Routing and alerts still work from saved data",

  /* ---- map ---- */
  "map.unavailable": "Map unavailable — routes and alerts still work",
  "map.youAreHere": "Your location",
  "map.locate": "Use my location",
  "map.locating": "Finding your location…",
  "map.locateDenied": "Location unavailable",
  "map.legend": "Network",
  "map.attribution": "Map data",
  "map.riskLayer": "Risk overlay",
  "map.routeLine": "Your route",

  /* ---- locale ---- */
  "locale.toggle": "Language",
  "locale.en": "EN",
  "locale.ms": "BM",
  "locale.name.en": "English",
  "locale.name.ms": "Bahasa Malaysia",

  /* ---- common ---- */
  "common.min": "min",
  "common.minutes": "{n} min",
  "common.hoursMinutes": "{h} h {m} min",
  "common.close": "Close",
  "common.done": "Done",
  "common.loading": "Loading…",
  "common.error": "Something went wrong",
  "common.retry": "Try again",
  "common.tapForEvidence": "Tap for evidence",
  "common.and": "and",
  "common.of": "of",

  /* ---- accessibility ---- */
  "a11y.sheet": "Route sheet",
  "a11y.dragHandle": "Drag to resize the route sheet",
  "a11y.staleness": "Data freshness",
  "a11y.offlineNotice": "Offline notice",
  "a11y.confidenceMeter": "Confidence {pct} percent",
} as const;

export type TranslationKey = keyof typeof en;
export type Dictionary = Record<TranslationKey, string>;
