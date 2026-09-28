/**
 * Bahasa Malaysia dictionary.
 *
 * Typed as a complete `Record<TranslationKey, string>` derived from `en`, so a
 * missing or extra key is a TypeScript error. tests/ui/i18n.test.ts asserts the
 * same property at runtime.
 *
 * Register notes: this is the everyday commuter register used on Rapid KL
 * announcements and on Malaysian social media — not a literal translation.
 * "Laluan" for line/route, "pertukaran" for interchange, "gangguan" for
 * disruption, "setakat" for "as of".
 */
import type { Dictionary } from "./en";

export const ms: Dictionary = {
  /* ---- app ---- */
  "app.name": "Kebolehpercayaan",
  "app.tagline": "Kebarangkalian tiba, bukan masa purata",

  /* ---- search / peek ---- */
  "search.from": "Dari",
  "search.to": "Ke",
  "search.pickOrigin": "Stesen permulaan",
  "search.pickDestination": "Stesen destinasi",
  "search.swap": "Tukar stesen asal dan destinasi",
  "search.cta": "Cari laluan boleh dipercayai",
  "search.ctaShort": "Pergi",
  "search.searchPlaceholder": "Cari stesen",
  "search.noResults": "Tiada stesen sepadan",
  "search.clear": "Kosongkan",
  "search.interchange": "Pertukaran",
  "search.accessible": "Akses tanpa tangga",
  "search.lines": "Laluan",
  "search.popular": "Perjalanan biasa",

  /* ---- sheet ---- */
  "sheet.handle": "Panel laluan",
  "sheet.expand": "Besarkan panel laluan",
  "sheet.collapse": "Kecilkan panel laluan",
  "sheet.detent.peek": "Kecil",
  "sheet.detent.half": "Separuh",
  "sheet.detent.full": "Penuh",
  "sheet.resizeHint": "Seret untuk ubah saiz",

  /* ---- results ---- */
  "results.title": "Laluan",
  "results.count": "{count} pilihan",
  "results.countOne": "1 pilihan",
  "results.rank": "Pilihan {rank}",
  "results.topOption": "Kebolehpercayaan tertinggi",
  "results.whyThisRank": "Mengapa kedudukan ini",
  "results.whyTop": "Mengapa ini pilihan utama",
  "results.typical": "Biasa",
  "results.p90": "P90",
  "results.p90Label": "90% perjalanan tiba sebelum {time}",
  "results.window": "{p50} – {p90}",
  "results.expectedDelay": "+{min} min kelewatan dijangka",
  "results.onTime": "Tiada kelewatan dijangka",
  "results.transfers": "{count} pertukaran",
  "results.transfersOne": "1 pertukaran",
  "results.transfersNone": "Tiada pertukaran",
  "results.lines": "{count} laluan",
  "results.risk": "Risiko",
  "results.noRisk": "Tiada risiko diketahui",
  "results.empty": "Tiada laluan ditemui untuk pasangan ini",
  "results.noSafeAlternative":
    "Tiada pilihan yang selamat sepenuhnya — setiap laluan melalui gangguan yang disahkan",
  "results.fallback": "Pengangkutan darat",
  "results.fallbackNote": "Cadangan alternatif sementara rangkaian pulih",
  "results.select": "Guna laluan ini",
  "results.selected": "Dipilih",
  "results.computedOffline": "Dikira di luar talian daripada data disimpan",
  "results.whyWrong": "Sebab paling mungkin ini salah",

  /* ---- rank explanations ---- */
  "why.saferThanFaster":
    "Lambat {delta} min berbanding pilihan terpantas, tetapi mengelak gangguan disahkan yang dilalui laluan itu.",
  "why.clean": "Tiada gangguan diketahui pada mana-mana segmen laluan ini.",
  "why.mostReliable": "Kebolehpercayaan tertinggi daripada {count} pilihan untuk perjalanan ini.",
  "why.lowerRisk":
    "Laluan ini melalui {severity} {issue} pada keyakinan {pct}%, jadi kedudukannya lebih rendah.",
  "why.lowerScore": "Kurang boleh dipercayai berbanding pilihan di atasnya.",
  "why.riskOnBoard": "{severity} {issue} pada laluan ini, keyakinan {pct}%.",
  "why.delayAdded": "Kira-kira {min} min kelewatan dijangka.",
  "why.slowerThanFastest": "{delta} min lebih lambat daripada pilihan terpantas.",
  "why.fastestOption": "Pilihan terpantas, tetapi bukan paling boleh dipercayai.",

  /* ---- reliability badges ---- */
  "badge.VERY_RELIABLE": "Sangat boleh dipercayai",
  "badge.RELIABLE": "Boleh dipercayai",
  "badge.UNCERTAIN": "Tidak pasti",
  "badge.AT_RISK": "Berisiko",
  "badge.AVOID": "Elakkan",

  /* ---- severity ---- */
  "severity.INFO": "Maklumat",
  "severity.MINOR": "Kecil",
  "severity.MAJOR": "Besar",
  "severity.SEVERE": "Teruk",

  /* ---- issue types ---- */
  "issue.TRACK_FAULT": "Kerosakan landasan",
  "issue.SIGNAL_FAULT": "Kerosakan isyarat",
  "issue.VEHICLE_BREAKDOWN": "Kerosakan tren",
  "issue.ELEVATOR_FAULT": "Kerosakan lif",
  "issue.DOOR_FAULT": "Kerosakan pintu",
  "issue.CROWDING": "Kesesakan",
  "issue.DELAY": "Kelewatan",
  "issue.ROAD_BLOCKED": "Jalan terhalang",
  "issue.WEATHER": "Cuaca",
  "issue.UNKNOWN": "Laporan belum dipastikan",

  /* ---- signal status ---- */
  "status.CANDIDATE": "Laporan belum disahkan",
  "status.REPORTED": "Dilaporkan",
  "status.CONFIRMED": "Disahkan",
  "status.CLEARED": "Selesai",
  "status.REJECTED": "Ditolak",

  /* ---- disruption card ---- */
  "alert.title": "Gangguan",
  "alert.titlePlural": "Gangguan",
  "alert.what": "Apa",
  "alert.where": "Di mana",
  "alert.severity": "Keterukan",
  "alert.confidence": "Keyakinan",
  "alert.sources": "Sumber",
  "alert.sourcesOfficial": "{count} rasmi",
  "alert.sourcesSocial": "{count} individu berbeza",
  "alert.sourcesRealtime": "{count} pemerhatian langsung",
  "alert.lead": "Masa pendahuluan",
  "alert.leadTime": "{min} min sebelum pengendali",
  "alert.leadTimeNone": "Pengendali belum mengakui gangguan ini",
  "alert.firstSeen": "Kali pertama dikesan",
  "alert.operatorNotified": "Pengendali dimaklumkan",
  "alert.notNotified": "Belum dimaklumkan",
  "alert.window": "Tempoh",
  "alert.reasoning": "Penilaian",
  "alert.humanCheck": "Seorang manusia akan menyemak ini",
  "alert.unresolved": "Lokasi belum dipastikan",
  "alert.candidates": "{count} segmen berkemungkinan",
  "alert.explain": "Mengapa kami percaya ini?",
  "alert.ongoing": "Masih berlaku",
  "alert.none": "Tiada gangguan aktif",
  "alert.noneBody": "Tiada apa-apa yang menjejaskan rangkaian yang kami dapat kesan.",
  "alert.affectsYourRoute": "Pada laluan anda",
  "alert.segment": "Segmen",
  "alert.line": "Laluan",

  /* ---- source inspector ---- */
  "source.title": "Mengapa kami percaya ini",
  "source.claim": "Dakwaan",
  "source.steps": "Bagaimana kami sampai ke sini",
  "source.confidenceByHop": "Keyakinan pada setiap langkah",
  "source.hop.INGEST": "Serapan",
  "source.hop.VERIFY": "Pengesahan",
  "source.hop.IMPACT": "Kesan",
  "source.hop.ADVISORY": "Nasihat",
  "source.refs": "Berasaskan",
  "source.routeDecision": "Bagaimana ini mengubah laluan anda",
  "source.routeDecisionBody":
    "Isyarat ini menambah {delay} min kelewatan dijangka pada pilihan {rank}, sebab itu ia berada di bawah laluan yang lebih selamat.",
  "source.routeDecisionNone":
    "Isyarat ini tidak mengubah kedudukan laluan yang kami kembalikan.",
  "source.back": "Kembali",
  "source.close": "Tutup",
  "source.rawText": "Teks sumber",
  "source.openSource": "Buka sumber asal",
  "source.author": "Dihantar oleh",
  "source.published": "Diterbitkan",
  "source.language": "Bahasa",
  "source.noTrace": "Tiada penjelasan tersedia untuk item ini",
  "source.stepConfidence": "{pct}% yakin",

  /* ---- confidence bands ---- */
  "confidence.VERY_LOW": "Sangat rendah",
  "confidence.LOW": "Rendah",
  "confidence.MODERATE": "Sederhana",
  "confidence.HIGH": "Tinggi",
  "confidence.VERY_HIGH": "Sangat tinggi",
  "confidence.reducedOffline": "Dikurangkan — cache luar talian",

  /* ---- staleness / offline ---- */
  "stale.asOf": "setakat {time}, {min} min lalu",
  "stale.asOfJustNow": "setakat {time}, kurang daripada seminit lalu",
  "stale.asOfHours": "setakat {time}, {h} j {m} min lalu",
  "stale.live": "Langsung",
  "stale.cached": "Data disimpan",
  "offline.offline": "Luar talian",
  "offline.banner": "Anda di luar talian — memaparkan data disimpan",
  "offline.confidenceReduced": "Keyakinan risiko dikurangkan semasa di luar talian",
  "offline.retry": "Cuba lagi",
  "offline.stillWorks": "Perancangan laluan dan makluman masih berfungsi daripada data disimpan",

  /* ---- map ---- */
  "map.unavailable": "Peta tidak tersedia — laluan dan makluman masih berfungsi",
  "map.youAreHere": "Lokasi anda",
  "map.locate": "Guna lokasi saya",
  "map.locating": "Mencari lokasi anda…",
  "map.locateDenied": "Lokasi tidak tersedia",
  "map.legend": "Rangkaian",
  "map.attribution": "Data peta",
  "map.riskLayer": "Lapisan risiko",
  "map.routeLine": "Laluan anda",

  /* ---- locale ---- */
  "locale.toggle": "Bahasa",
  "locale.en": "EN",
  "locale.ms": "BM",
  "locale.name.en": "English",
  "locale.name.ms": "Bahasa Malaysia",

  /* ---- common ---- */
  "common.min": "min",
  "common.minutes": "{n} min",
  "common.hoursMinutes": "{h} j {m} min",
  "common.close": "Tutup",
  "common.done": "Selesai",
  "common.loading": "Memuatkan…",
  "common.error": "Ada sesuatu yang tidak kena",
  "common.retry": "Cuba lagi",
  "common.tapForEvidence": "Ketik untuk bukti",
  "common.and": "dan",
  "common.of": "daripada",

  /* ---- accessibility ---- */
  "a11y.sheet": "Helaian laluan",
  "a11y.dragHandle": "Seret untuk ubah saiz helaian laluan",
  "a11y.staleness": "Kesegaran data",
  "a11y.offlineNotice": "Notis luar talian",
  "a11y.confidenceMeter": "Keyakinan {pct} peratus",
};
