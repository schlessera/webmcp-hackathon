import { readFileSync, writeFileSync } from "node:fs";
import { parseWebsite, robotsAllows } from "/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts";

const DIR = "/tmp/codex-crawl.iu90UN/berlin-mitte-A";
const UA = "spokes-research/0.2 (+https://github.com/schlessera/webmcp-hackathon; structured-data survey)";
const TIMEOUT = 12_000, MAX = 2_000_000, CONCURRENCY = 8;
const menuRE = /(?:menu|menü|speisekarte|(?:^|\W)karte(?:\W|$)|carte|getränke|drinks?|food|essen|mittag|lunch|dinner|\.pdf(?:\?|$))/i;
const reservationHosts = ["opentable", "resy", "quandoo", "thefork", "sevenrooms", "exploretock", "tock"];
const deliveryHosts = ["lieferando", "wolt", "ubereats", "doordash", "deliveroo", "grubhub"];
const socials = ["instagram", "facebook"];
const builders = {
  wix: /wixstatic|wix\.com|wix-code/i, squarespace: /static1\.squarespace|squarespace/i,
  wordpress: /wp-content|wp-includes|wordpress/i, shopify: /cdn\.shopify|shopify\.theme|myshopify/i,
  webflow: /webflow\.com|data-wf-/i, jimdo: /jimdo|jimdofree/i, weebly: /weebly/i,
  typo3: /typo3/i, drupal: /drupalSettings|sites\/default\/files/i, joomla: /\/media\/system\/js|joomla/i,
  sitejet: /sitejet/i, duda: /duda\.co|dmcdn\.net/i, gastronovi: /gastronovi/i,
};
const dietaryPatterns = {
  vegan: /\bvegan\b/gi, vegetarian: /\b(?:vegetarian|vegetarisch)\b/gi,
  glutenFree: /\b(?:gluten[ -]?free|glutenfrei)\b/gi,
  lactoseFree: /\b(?:lactose[ -]?free|laktosefrei)\b/gi, halal: /\bhalal\b/gi,
  allergen: /\b(?:allergens?|allergene[n]?)\b/gi, v: /\(v\)/gi, vg: /\bvg\b/gi,
};

const clean = s => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|quot|#39);/gi, " ").replace(/\s+/g, " ").trim();
const snippet = s => clean(s).slice(0, 200);
const normalizeUrl = raw => { try { const s = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`; return new URL(s).toString(); } catch { return null; } };
const hostKind = url => { try { const h = new URL(url).hostname.toLowerCase(); return reservationHosts.find(x => h.includes(x)) ?? deliveryHosts.find(x => h.includes(x)) ?? socials.find(x => h.includes(x)) ?? null; } catch { return null; } };

async function fetchLimited(url, accept) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: ctl.signal });
    const declared = Number(res.headers.get("content-length"));
    if (declared > MAX) { await res.body?.cancel(); return { status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") ?? "", bytes: declared, tooLarge: true }; }
    const chunks = []; let bytes = 0;
    if (res.body) for await (const chunk of res.body) { bytes += chunk.byteLength; if (bytes > MAX) { await res.body.cancel().catch(()=>{}); return { status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") ?? "", bytes, tooLarge: true }; } chunks.push(chunk); }
    return { status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") ?? "", bytes, body: Buffer.concat(chunks).toString("utf8") };
  } finally { clearTimeout(timer); }
}

const robotsCache = new Map();
async function allowed(url) {
  const u = new URL(url), key = u.origin;
  if (!robotsCache.has(key)) robotsCache.set(key, (async () => {
    try { const r = await fetchLimited(`${key}/robots.txt`, "text/plain"); return r.status >= 200 && r.status < 300 ? (r.body ?? "").slice(0, 100_000) : ""; } catch { return ""; }
  })());
  return robotsAllows(await robotsCache.get(key), u.pathname || "/");
}

function anchors(html, base) {
  const out=[];
  for (const m of html.matchAll(/<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    try { const url = new URL(m[2], base).toString(); if (/^https?:/i.test(url)) out.push({ url, text: clean(m[4]).slice(0,160), html: m[0].slice(0,500) }); } catch {}
  }
  return out;
}

function jsonLdAudit(html) {
  const nodes=[]; let blocks=0, broken=0;
  const walk = (x, path="$") => { if (Array.isArray(x)) return x.forEach((v,i)=>walk(v,`${path}[${i}]`)); if (!x || typeof x!=="object") return; nodes.push({ path, types: [].concat(x["@type"]??[]).map(String), keys: Object.keys(x), data:x }); if (x["@graph"]) walk(x["@graph"],`${path}.@graph`); };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { blocks++; try { walk(JSON.parse(m[1].trim())); } catch { broken++; } }
  const fieldEvidence=[];
  for (const n of nodes) for (const k of ["servesCuisine","priceRange","openingHours","openingHoursSpecification","aggregateRating","amenityFeature","hasMenu","menu","acceptsReservations","description"]) if (n.data[k] != null) fieldEvidence.push({ path:n.path, types:n.types, field:k, value:snippet(JSON.stringify(n.data[k])) });
  return { blocks, broken, nodeCount:nodes.length, types:[...new Set(nodes.flatMap(n=>n.types))], fieldEvidence };
}

async function crawl(v) {
  const requestedUrl=normalizeUrl(v.website); const r={ ref:v.ref, name:v.name, distanceM:v.distanceM, website:v.website, requestedUrl, status:null, finalUrl:null, contentType:null, bytes:0, robotsAllowed:null, error:null, builders:[], facts:null, menuLinks:[], reservationLinks:[], deliveryLinks:[], socialLinks:[], jsonLd:null, evidence:[], menuFetch:null };
  if (!requestedUrl) { r.error="invalid URL"; return r; }
  try { r.robotsAllowed=await allowed(requestedUrl); if (!r.robotsAllowed) { r.error="robots.txt disallows"; return r; }
    const p=await fetchLimited(requestedUrl,"text/html,application/xhtml+xml"); Object.assign(r,{status:p.status,finalUrl:p.finalUrl,contentType:p.contentType,bytes:p.bytes});
    if (p.tooLarge) { r.error="body over 2 MB"; return r; } if (!p.body || !/html|xhtml|xml|text\//i.test(p.contentType)) { if (!(p.status>=200&&p.status<300)) r.error=`HTTP ${p.status}`; else r.error="not HTML"; return r; }
    const html=p.body, base=p.finalUrl||requestedUrl; r.builders=Object.entries(builders).filter(([,re])=>re.test(html)).map(([x])=>x); r.facts=parseWebsite(html,base,new Date().toISOString()); r.jsonLd=jsonLdAudit(html);
    const aa=anchors(html,base); r.menuLinks=aa.filter(a=>menuRE.test(a.url)||menuRE.test(a.text)).map(({url,text})=>({url,text}));
    r.reservationLinks=aa.filter(a=>reservationHosts.some(x=>hostKind(a.url)===x)).map(({url,text})=>({platform:hostKind(url),url,text}));
    r.deliveryLinks=aa.filter(a=>deliveryHosts.some(x=>hostKind(a.url)===x)).map(({url,text})=>({platform:hostKind(url),url,text}));
    r.socialLinks=aa.filter(a=>socials.some(x=>hostKind(a.url)===x)).map(({url,text})=>({platform:hostKind(url),url,text}));
    r.evidence=aa.filter(a=>menuRE.test(a.text) || menuRE.test(a.url)).slice(0,8).map(a=>({kind:"menu-link",snippet:snippet(a.html)}));
    for (const ev of r.jsonLd.fieldEvidence.slice(0,12)) r.evidence.push({kind:`jsonld:${ev.field}`,snippet:ev.value,path:ev.path,types:ev.types});
    if (r.menuLinks.length) {
      const homeHost=new URL(base).host; const ordered=[...r.menuLinks].sort((a,b)=>Number(new URL(b.url).host===homeHost)-Number(new URL(a.url).host===homeHost)); const chosen=ordered[0];
      const mf={url:chosen.url,status:null,finalUrl:null,contentType:null,bytes:0,robotsAllowed:null,error:null,dietary:null,classification:null};
      try { mf.robotsAllowed=await allowed(chosen.url); if (!mf.robotsAllowed) mf.error="robots.txt disallows"; else { const q=await fetchLimited(chosen.url,"text/html,text/plain,application/pdf,image/*;q=0.8"); Object.assign(mf,{status:q.status,finalUrl:q.finalUrl,contentType:q.contentType,bytes:q.bytes}); if(q.tooLarge) mf.error="body over 2 MB"; const ct=q.contentType.toLowerCase(), fh=new URL(q.finalUrl||chosen.url).host; mf.classification=ct.includes("pdf")||/\.pdf(?:$|\?)/i.test(q.finalUrl||chosen.url)?"pdf":ct.startsWith("image/")?"image-only":fh!==homeHost?"third-party":/html|text\//.test(ct)?"same-host-html":null; if(q.body && /html|text\//.test(ct)) { mf.dietary={}; for(const [k,re] of Object.entries(dietaryPatterns)) mf.dietary[k]=(q.body.match(re)||[]).length; } } } catch(e) { mf.error=`${e.name}: ${e.message}`.slice(0,160); } r.menuFetch=mf;
    }
  } catch(e) { r.error=`${e.name}: ${e.message}`.slice(0,160); }
  return r;
}

const venues=JSON.parse(readFileSync(`${DIR}/venues.json`,"utf8")); const results=new Array(venues.length); let next=0, done=0;
await Promise.all(Array.from({length:CONCURRENCY},async()=>{ while(true){ const i=next++; if(i>=venues.length)return; results[i]=await crawl(venues[i]); done++; if(done%25===0) console.log(`${done}/${venues.length}`); } }));
const countBy=(xs,key)=>Object.fromEntries([...new Set(xs.map(x=>x?.[key]).filter(Boolean))].sort().map(k=>[k,xs.filter(x=>x?.[key]===k).length]));
const ok=results.filter(x=>x.status>=200&&x.status<300), menus=results.filter(x=>x.menuFetch), fetchedMenus=menus.filter(x=>x.menuFetch.status!=null);
const summary={ total:results.length, robotsDisallowed:results.filter(x=>x.robotsAllowed===false).length, homepageStatus:countBy(results,"status"), homepage2xx:ok.length, homepageHtml:ok.filter(x=>/html|xml|text\//i.test(x.contentType)).length, over2MB:results.filter(x=>x.error==="body over 2 MB").length, errors:results.filter(x=>x.error).length, builders:Object.fromEntries(Object.keys(builders).map(k=>[k,results.filter(x=>x.builders.includes(k)).length])), parseWebsite:{ anyJsonLd:results.filter(x=>x.jsonLd?.blocks>0).length, brokenJsonLd:results.filter(x=>x.jsonLd?.broken>0).length, factsCuisine:results.filter(x=>x.facts?.cuisine).length, factsPrice:results.filter(x=>x.facts?.priceLevel).length, factsHours:results.filter(x=>x.facts?.hours).length, factsRating:results.filter(x=>x.facts?.rating).length, factsWheelchair:results.filter(x=>x.facts?.wheelchair!==undefined).length, factsMenuUrl:results.filter(x=>x.facts?.menuUrl).length, factsReservationsUrl:results.filter(x=>x.facts?.reservationsUrl).length, factsDescription:results.filter(x=>x.facts?.description).length }, discovered:{ menuLinks:results.filter(x=>x.menuLinks.length).length, reservationLinks:results.filter(x=>x.reservationLinks.length).length, deliveryLinks:results.filter(x=>x.deliveryLinks.length).length, instagram:results.filter(x=>x.socialLinks.some(y=>y.platform==="instagram")).length, facebook:results.filter(x=>x.socialLinks.some(y=>y.platform==="facebook")).length }, menuFetches:{ attempted:menus.length, withStatus:fetchedMenus.length, status:countBy(menus.map(x=>x.menuFetch),"status"), classification:countBy(menus.map(x=>x.menuFetch),"classification"), dietaryAny:fetchedMenus.filter(x=>x.menuFetch.dietary&&Object.values(x.menuFetch.dietary).some(Boolean)).length }, reservationPlatforms:{}, deliveryPlatforms:{} };
for(const p of reservationHosts) summary.reservationPlatforms[p]=results.filter(x=>x.reservationLinks.some(y=>y.platform===p)).length;
for(const p of deliveryHosts) summary.deliveryPlatforms[p]=results.filter(x=>x.deliveryLinks.some(y=>y.platform===p)).length;
writeFileSync(`${DIR}/results.json`,JSON.stringify(results,null,2)); writeFileSync(`${DIR}/summary.json`,JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary,null,2));
