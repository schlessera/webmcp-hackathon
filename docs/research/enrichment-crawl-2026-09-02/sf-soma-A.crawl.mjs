import { readFileSync, writeFileSync } from "node:fs";
import { parseWebsite, robotsAllows } from "/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts";

const ROOT = "/tmp/codex-crawl.iu90UN/sf-soma-A";
const UA = "spokes-research/0.2 (+https://github.com/schlessera/webmcp-hackathon; structured-data survey)";
const TIMEOUT = 12_000, MAX = 2_000_000, CONCURRENCY = 8;
const venues = JSON.parse(readFileSync(`${ROOT}/venues.json`, "utf8"));
const robotsCache = new Map();
const menuRe = /(?:menu|menü|speisekarte|(?:^|\W)karte(?:\W|$)|carte|getränke|drinks?|food|essen|mittag|lunch|dinner|\.pdf(?:\W|$))/i;
const reservationHosts = ["opentable", "resy", "quandoo", "thefork", "sevenrooms", "exploretock", "tockhq", "tock"];
const deliveryHosts = ["lieferando", "wolt", "ubereats", "doordash", "deliveroo", "grubhub"];
const socialHosts = ["instagram", "facebook"];
const builders = {
  wix: /wixstatic|wix\.com|wix-code|wixbi/i, squarespace: /static\.squarespace|squarespace-cdn|squarespace/i,
  wordpress: /wp-content|wp-includes|wordpress/i, shopify: /cdn\.shopify|shopify-section|Shopify\./i,
  webflow: /webflow\.com|data-wf-(?:page|site)/i, jimdo: /jimdo|jimdofree/i,
  toast: /toasttab|toast\.site/i, bentobox: /bentoboxcdn|bento-box/i,
  weebly: /weebly|editmysite/i, godaddy: /godaddy|secureservercdn/i,
  clover: /clover\.com|clover-sites/i, popmenu: /popmenu/i,
};

const clean = s => s.replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|quot|#39);/gi, " ").replace(/\s+/g, " ").trim();
const around = (html, needle) => {
  const i = Math.max(0, typeof needle === "number" ? needle : html.toLowerCase().indexOf(String(needle).toLowerCase()));
  return clean(html.slice(Math.max(0, i - 70), i + 160)).slice(0, 200);
};
const urlOf = (href, base) => { try { const u = new URL(href, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
function linksOf(html, base) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = urlOf(m[2].replace(/&amp;/g, "&"), base), text = clean(m[3]);
    if (href) links.push({ href, text: text.slice(0, 180), snippet: around(html, m.index) });
  }
  return links;
}
function platformLinks(links, names) {
  return links.filter(l => names.some(n => { try { return new URL(l.href).hostname.toLowerCase().includes(n); } catch { return false; } }));
}
async function robotsOK(u) {
  const key = u.origin;
  if (!robotsCache.has(key)) robotsCache.set(key, (async () => {
    try {
      const r = await fetch(`${key}/robots.txt`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(4000), redirect: "follow" });
      return r.ok ? (await r.text()).slice(0, 100_000) : "";
    } catch { return ""; }
  })());
  return robotsAllows(await robotsCache.get(key), u.pathname || "/");
}
async function fetchLimited(url, accept) {
  const u = new URL(url);
  if (!await robotsOK(u)) return { status: "robots-disallowed", finalUrl: url };
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT) });
    const type = res.headers.get("content-type") || "";
    const declared = Number(res.headers.get("content-length"));
    const out = { status: res.status, finalUrl: res.url || url, contentType: type.split(";")[0], declaredBytes: Number.isFinite(declared) ? declared : null };
    if (declared > MAX) return { ...out, skippedOversize: true, bytes: 0 };
    const reader = res.body?.getReader(); let size = 0; const chunks = [];
    while (reader) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX) { await reader.cancel(); return { ...out, skippedOversize: true, bytes: size }; } chunks.push(value); }
    const body = Buffer.concat(chunks.map(x => Buffer.from(x)));
    return { ...out, bytes: body.length, body };
  } catch (e) { return { status: `${e?.name || "Error"}: ${e?.message || e}`.slice(0, 160), finalUrl: url }; }
}
function inspectJsonLd(html) {
  const nodes = []; let blocks = 0, broken = 0;
  const walk = x => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { nodes.push(x); if (x["@graph"]) walk(x["@graph"]); } };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    blocks++; try { walk(JSON.parse(m[1].trim())); } catch { broken++; }
  }
  const types = nodes.flatMap(n => [].concat(n["@type"] || []).map(String));
  const fields = {};
  for (const key of ["servesCuisine","priceRange","openingHours","openingHoursSpecification","aggregateRating","amenityFeature","hasMenu","menu","acceptsReservations","description"]) {
    fields[key] = nodes.filter(n => n[key] != null).length;
  }
  const menuObjects = nodes.filter(n => [].concat(n["@type"] || []).some(t => /Menu/i.test(String(t))));
  return { blocks, broken, nodes: nodes.length, types: [...new Set(types)].slice(0,30), typeArrays: nodes.filter(n => Array.isArray(n["@type"])).length, fields, menuObjects: menuObjects.length };
}
const dietaryPatterns = {
  vegan: /\bvegan\b/gi, vegetarian: /\b(?:vegetarian|vegetarisch)\b/gi,
  glutenFree: /\b(?:gluten[ -]?free|glutenfrei)\b/gi, lactoseFree: /\b(?:lactose[ -]?free|laktosefrei)\b/gi,
  halal: /\bhalal\b/gi, allergen: /\b(?:allergens?|allergene)\b/gi,
  vMarker: /(?:^|[\s,;])\(v\)(?=$|[\s,;])/gi, vgMarker: /(?:^|[\s,;])vg(?=$|[\s,;])/gi,
};
function markers(text) { return Object.fromEntries(Object.entries(dietaryPatterns).map(([k,re]) => [k, [...text.matchAll(re)].length])); }

async function crawl(v) {
  let website = v.website; if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
  const base = { ref:v.ref, name:v.name, distanceM:v.distanceM, website, tags:v.tags };
  let home;
  try { home = await fetchLimited(website, "text/html,application/xhtml+xml"); } catch (e) { return { ...base, homepage:{ status:`invalid-url: ${e.message}` } }; }
  const homepage = Object.fromEntries(Object.entries(home).filter(([k]) => k !== "body"));
  if (!home.body || !/html|xml|text\//i.test(home.contentType || "")) return { ...base, homepage };
  const html = home.body.toString("utf8"), links = linksOf(html, home.finalUrl);
  const menuLinks = links.filter(l => menuRe.test(`${l.href} ${l.text}`));
  const finalHost = new URL(home.finalUrl).hostname.replace(/^www\./, "");
  menuLinks.sort((a,b) => (new URL(b.href).hostname.replace(/^www\./,"") === finalHost) - (new URL(a.href).hostname.replace(/^www\./,"") === finalHost));
  let facts = null, parseError = null; try { facts = parseWebsite(html, home.finalUrl, new Date().toISOString()); } catch(e) { parseError = String(e); }
  const page = {
    builders: Object.entries(builders).filter(([,r]) => r.test(html)).map(([k]) => k), facts, parseError,
    jsonLd: inspectJsonLd(html), menuLinks,
    reservationLinks: platformLinks(links,reservationHosts), deliveryLinks: platformLinks(links,deliveryHosts), socialLinks: platformLinks(links,socialHosts),
  };
  if (!menuLinks.length) return { ...base, homepage, page };
  const chosen = menuLinks[0].href; let mf;
  try { mf = await fetchLimited(chosen, "text/html,application/xhtml+xml,application/pdf,image/*,text/plain"); } catch(e) { mf = { status:`invalid-url: ${e.message}`, finalUrl:chosen }; }
  const menuFetch = Object.fromEntries(Object.entries(mf).filter(([k]) => k !== "body"));
  if (mf.body && /html|text|xml/i.test(mf.contentType || "")) menuFetch.dietaryMarkers = markers(mf.body.toString("utf8"));
  const mh = (() => { try { return new URL(mf.finalUrl || chosen).hostname.replace(/^www\./,""); } catch { return ""; } })();
  menuFetch.classification = /pdf/i.test(mf.contentType || "") || /\.pdf(?:$|[?#])/i.test(mf.finalUrl || chosen) ? "pdf" : /^image\//i.test(mf.contentType || "") ? "image-only" : /html|text|xml/i.test(mf.contentType || "") && mh === finalHost ? "html-same-host" : mh !== finalHost ? "third-party" : "other";
  return { ...base, homepage, page, menuFetch };
}

const results = Array(venues.length); let next = 0, done = 0;
await Promise.all(Array.from({length:CONCURRENCY}, async () => { while (true) { const i=next++; if (i>=venues.length) break; results[i]=await crawl(venues[i]); done++; if (done%25===0) process.stderr.write(`done ${done}/${venues.length}\n`); } }));
const num = f => results.filter(f).length;
const platformCounts = kind => { const x={}; for(const r of results) for(const l of r.page?.[kind]||[]) { const h=new URL(l.href).hostname.replace(/^www\./,""); const p=[...reservationHosts,...deliveryHosts].find(n=>h.includes(n))||h; x[p]=(x[p]||0)+1; } return x; };
const menuFetched = results.filter(r=>r.menuFetch), markerMenus=menuFetched.filter(r=>Object.values(r.menuFetch.dietaryMarkers||{}).some(Boolean));
const summary = {
  venues:results.length, robotsDisallowed:num(r=>r.homepage.status==="robots-disallowed"), http2xx:num(r=>Number(r.homepage.status)>=200&&Number(r.homepage.status)<300),
  parseablePages:num(r=>!!r.page), anyJsonLd:num(r=>(r.page?.jsonLd.blocks||0)>0), structuredFacts:num(r=>{const f=r.page?.facts||{}; return [f.cuisine,f.priceLevel,f.hours,f.rating,f.wheelchair,f.menuUrl,f.reservationsUrl,f.description].some(x=>x!==undefined)}),
  discoveredMenuLinks:num(r=>(r.page?.menuLinks.length||0)>0), menuFetches:menuFetched.length,
  menuClassifications:Object.fromEntries(["html-same-host","pdf","image-only","third-party","other"].map(k=>[k,menuFetched.filter(r=>r.menuFetch.classification===k).length])),
  menuWithDietaryMarkers:markerMenus.length, reservationPlatforms:platformCounts("reservationLinks"), deliveryPlatforms:platformCounts("deliveryLinks"),
  builders:Object.fromEntries(Object.keys(builders).map(k=>[k,num(r=>r.page?.builders.includes(k))])),
  statuses:Object.fromEntries([...new Set(results.map(r=>String(r.homepage.status)))].map(s=>[s,num(r=>String(r.homepage.status)===s)])), generatedAt:new Date().toISOString()
};
writeFileSync(`${ROOT}/results.json`, JSON.stringify(results,null,2));
writeFileSync(`${ROOT}/summary.json`, JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
