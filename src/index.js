import ICAL from "ical.js";

const MEMBERS = [
  { id: "nat", name: "Nat", secretKey: "ICS_URL_NAT" },
  { id: "rob", name: "Rob", secretKey: "ICS_URL_ROB" },
  { id: "ella", name: "Ella", secretKey: "ICS_URL_ELLA" },
  { id: "noah", name: "Noah", secretKey: "ICS_URL_NOAH" }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/calendar/events") {
      return handleEventsRequest(request, env, ctx);
    }

    // Fallback to static assets in /public
    return env.ASSETS.fetch(request);
  }
};

async function handleEventsRequest(request, env, ctx) {
  // Optional extra layer if you set DEVICE_TOKEN in Cloudflare Secrets
  if (env.DEVICE_TOKEN) {
    const authHeader = request.headers.get("Authorization") || "";
    const tokenParam = new URL(request.url).searchParams.get("token");
    if (authHeader !== `Bearer ${env.DEVICE_TOKEN}` && tokenParam !== env.DEVICE_TOKEN) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
  }

  const reqUrl = new URL(request.url);
  const forceRefresh = reqUrl.searchParams.get("refresh") === "1";
  const stripNotes = reqUrl.searchParams.get("stripNotes") !== "0";
  const hideLocation = reqUrl.searchParams.get("hideLocation") === "1";

  // Edge cache check (10-minute TTL unless manual refresh)
  const cache = caches.default;
  const cacheKey = new Request(
    `${reqUrl.origin}/api/calendar/events?stripNotes=${stripNotes}&hideLocation=${hideLocation}`,
    { method: "GET" }
  );

  if (!forceRefresh) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // Query window: 7 days ago -> 21 days ahead
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - 7);
  windowStart.setHours(0, 0, 0, 0);

  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + 21);
  windowEnd.setHours(23, 59, 59, 999);

  const allEvents = [];
  const feedStatus = [];

  for (const member of MEMBERS) {
    const rawUrl = env[member.secretKey];
    if (!rawUrl) {
      feedStatus.push({ memberId: member.id, configured: false, status: "not_configured" });
      continue;
    }

    try {
      const fetchUrl = rawUrl.trim().replace(/^webcal:\/\//i, "https://");
      const res = await fetch(fetchUrl, {
        headers: { "User-Agent": "FamilyCalendarWorker/1.0" }
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const icsText = await res.text();
      const parsedEvents = parseIcsEvents(icsText, member.id, windowStart, windowEnd, {
        stripNotes,
        hideLocation
      });

      allEvents.push(...parsedEvents);
      feedStatus.push({
        memberId: member.id,
        configured: true,
        status: "ok",
        count: parsedEvents.length
      });
    } catch (err) {
      feedStatus.push({
        memberId: member.id,
        configured: true,
        status: "error",
        message: err.message
      });
    }
  }

  // Sort chronologically
  allEvents.sort((a, b) => a.start.localeCompare(b.start));

  const payload = {
    syncedAt: new Date().toISOString(),
    feeds: feedStatus,
    events: allEvents
  };

  const response = jsonResponse(payload, 200, {
    "Cache-Control": "public, max-age=600"
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function parseIcsEvents(icsText, memberId, windowStart, windowEnd, opts) {
  const jcalData = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcalData);
  const vevents = comp.getAllSubcomponents("vevent");
  const results = [];

  const rangeStart = ICAL.Time.fromJSDate(windowStart, false);
  const rangeEnd = ICAL.Time.fromJSDate(windowEnd, false);

  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);
    const summary = event.summary || "Busy";
    const location = opts.hideLocation ? "" : event.location || "";
    const description = opts.stripNotes ? "" : event.description || "";

    if (event.isRecurring()) {
      const expand = event.iterator();
      let next;
      let guard = 0;

      while ((next = expand.next()) && guard < 200) {
        guard++;
        if (next.compare(rangeEnd) > 0) break;

        const occ = event.getOccurrenceDetails(next);
        const startJs = occ.startDate.toJSDate();
        const endJs = occ.endDate.toJSDate();

        if (endJs >= windowStart && startJs <= windowEnd) {
          results.push(formatEvent(memberId, summary, startJs, endJs, occ.startDate.isDate, location, description));
        }
      }
    } else {
      const startJs = event.startDate.toJSDate();
      const endJs = event.endDate ? event.endDate.toJSDate() : startJs;

      if (endJs >= windowStart && startJs <= windowEnd) {
        results.push(formatEvent(memberId, summary, startJs, endJs, event.startDate.isDate, location, description));
      }
    }
  }

  return results;
}

function formatEvent(memberId, title, startJs, endJs, isAllDay, location, notes) {
  return {
    id: `${memberId}-${startJs.getTime()}-${title.slice(0, 12)}`,
    memberId,
    title,
    start: startJs.toISOString(),
    end: endJs.toISOString(),
    allDay: Boolean(isAllDay),
    location,
    notes
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}
