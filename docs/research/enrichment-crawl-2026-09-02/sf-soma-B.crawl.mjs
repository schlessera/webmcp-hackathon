import { readFileSync, writeFileSync } from "node:fs";
import { parseWebsite, robotsAllows } from "/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts";

const DIR = "/tmp/codex-crawl.iu90UN/sf-soma-B";
const UA = "spokes-research/0.2 (+https://github.com/schlessera/webmcp-hackathon; structured-data survey)";
const TIMEOUT = 12_000, MAX = 2_000_000;
const menuRe = /(?:menu|menü|speisekarte|karte|carte|getränke|drinks?|food|essen|mittag|lunch|dinner|\.pdf\b)/i;
const reserveHosts = ["opentable","resy","quandoo","thefork","sevenrooms","tock"];
const deliveryHosts = ["lieferando","wolt","ubereats","doordash","deliveroo","grubhub"];
const socialHosts = ["instagram","facebook"];
const builders = { wix:/wix(?:static|site|\.com)|wix-code/i, squarespace:/squarespace/i, wordpress:/wp-content|wp-includes|wordpress/i, shopify:/cdn\.shopify|shopify\.com|Shopify\.theme/i, webflow:/webflow/i, jimdo:/jimdo/i, weebly:/weebly/i, godaddy:/godaddy|wsimg\.com/i, toast:/toasttab/i, bentobox:/bentobox|bento-cdn/i };
const markers = { vegan:/\bvegan\b/gi, vegetarian:/\b(?:vegetarian|vegetarisch)\b/gi, glutenFree:/\b(?:gluten[- ]?free|glutenfrei)\b/gi, lactoseFree:/\b(?:lactose[- ]?free|laktosefrei)\b/gi, halal:/\bhalal\b/gi, allergen:/\b(?:allergens?|allergene)\b/gi, v:/\(v\)/gi, vg:/\bvg\b/gi };
const robotsCache = new Map();
const venues = JSON.parse(readFileSync(`${DIR}/venues.json`, "utf8"));

function urlOf(raw) { try { return new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`); } catch { return null; } }
function clip(s, n=200) { return String(s).replace(/\s+/g," ").trim().slice(0,n); }
function attrs(tag) { const o={}; for(const m of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) o[m[1].toLowerCase()]=m[2]??m[3]??m[4]; return o; }
function links(html, base) {
  const out=[];
  for (const m of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi)) {
    const a=attrs(m[0]), raw=a.href; if(!raw) continue;
    let href; try { href=new URL(raw,base).toString(); } catch { continue; }
    const text=clip(m[0].replace(/<[^>]+>/g," "),160);
    out.push({href,text,snippet:clip(m[0])});
  }
  return out;
}
function platform(url, names) { const s=url.toLowerCase(); return names.find(x=>s.includes(x)); }
function evidence(html) {
  const pats = [
    ["openingHoursSpecification", /.{0,70}openingHoursSpecification.{0,110}/gi], ["servesCuisine",/.{0,70}servesCuisine.{0,110}/gi],
    ["priceRange",/.{0,70}priceRange.{0,110}/gi], ["aggregateRating",/.{0,70}aggregateRating.{0,110}/gi],
    ["menuJsonLd",/.{0,70}"(?:hasMenu|menu)"\s*:.{0,110}/gi], ["menuObject",/.{0,70}"@type"\s*:\s*(?:\[[^\]]*\]|"Menu").{0,110}/gi]
  ];
  const e={}; for(const [k,re] of pats) { const m=re.exec(html); if(m)e[k]=clip(m[0]); } return e;
}
async function fetchBounded(url, accept="text/html,application/xhtml+xml,application/pdf,image/*;q=0.8") {
  const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),TIMEOUT);
  try {
    const res=await fetch(url,{headers:{"user-agent":UA,accept},redirect:"follow",signal:ctl.signal});
    const len=Number(res.headers.get("content-length"));
    if(Number.isFinite(len)&&len>MAX) { try{await res.body?.cancel();}catch{}; return {status:res.status,finalUrl:res.url||url,contentType:res.headers.get("content-type")||"",bytes:len,tooLarge:true}; }
    if(!res.body) return {status:res.status,finalUrl:res.url||url,contentType:res.headers.get("content-type")||"",bytes:0,body:new Uint8Array()};
    const reader=res.body.getReader(); let total=0, chunks=[];
    while(true){ const {done,value}=await reader.read(); if(done)break; total+=value.length; if(total>MAX){await reader.cancel(); return {status:res.status,finalUrl:res.url||url,contentType:res.headers.get("content-type")||"",bytes:total,tooLarge:true};} chunks.push(value); }
    const body=new Uint8Array(total); let p=0; for(const c of chunks){body.set(c,p);p+=c.length;}
    return {status:res.status,finalUrl:res.url||url,contentType:res.headers.get("content-type")||"",bytes:total,body};
  } catch(e) { return {status:null,finalUrl:url,error:`${e?.name||"Error"}: ${e?.message||e}`.slice(0,160)}; }
  finally { clearTimeout(timer); }
}
async function allowed(u) {
  if(!robotsCache.has(u.origin)) {
    const p=(async()=>{ const r=await fetchBounded(`${u.origin}/robots.txt`,"text/plain"); if(r.status>=200&&r.status<300&&r.body) return new TextDecoder().decode(r.body).slice(0,100000); return null; })();
    robotsCache.set(u.origin,p);
  }
  const robots=await robotsCache.get(u.origin);
  return robots===null ? true : robotsAllows(robots,u.pathname||"/");
}
async function one(v) {
  const target=urlOf(v.website), r={ref:v.ref,name:v.name,distanceM:v.distanceM,website:v.website,homepage:{status:null},builderHints:[],facts:null,menuLinks:[],reservationLinks:[],deliveryLinks:[],socialLinks:[],menuPage:null,evidence:{}};
  if(!target){r.homepage.error="invalid URL";return r;}
  if(!(await allowed(target))){r.homepage={status:null,finalUrl:target.toString(),robotsAllowed:false,error:"robots.txt disallows"};return r;}
  const h=await fetchBounded(target.toString()); r.homepage={status:h.status,finalUrl:h.finalUrl,contentType:h.contentType,bytes:h.bytes,tooLarge:!!h.tooLarge,error:h.error,robotsAllowed:true};
  if(!h.body||h.tooLarge||!/html|xhtml|xml/i.test(h.contentType||"")) return r;
  const html=new TextDecoder().decode(h.body), base=h.finalUrl; r.builderHints=Object.entries(builders).filter(([,x])=>x.test(html)).map(([x])=>x);
  try{r.facts=parseWebsite(html,base,new Date().toISOString());}catch(e){r.parseError=String(e?.message||e).slice(0,160);}
  const ls=links(html,base); r.menuLinks=ls.filter(x=>menuRe.test(x.href)||menuRe.test(x.text));
  r.reservationLinks=ls.filter(x=>platform(x.href,reserveHosts)).map(x=>({...x,platform:platform(x.href,reserveHosts)}));
  r.deliveryLinks=ls.filter(x=>platform(x.href,deliveryHosts)).map(x=>({...x,platform:platform(x.href,deliveryHosts)}));
  r.socialLinks=ls.filter(x=>platform(x.href,socialHosts)).map(x=>({...x,platform:platform(x.href,socialHosts)}));
  r.evidence=evidence(html);
  if(r.menuLinks.length){
    const homeHost=new URL(base).host; const candidates=[...r.menuLinks].sort((a,b)=>Number(new URL(b.href).host===homeHost)-Number(new URL(a.href).host===homeHost)); const first=candidates[0];
    const mu=new URL(first.href); if(await allowed(mu)) {
      const m=await fetchBounded(first.href); const sameHost=new URL(m.finalUrl||first.href).host===homeHost; const ct=m.contentType||""; const mp={url:first.href,finalUrl:m.finalUrl,status:m.status,contentType:ct,bytes:m.bytes,tooLarge:!!m.tooLarge,error:m.error,sameHost,platform:platform(m.finalUrl||first.href,[...reserveHosts,...deliveryHosts,"toasttab","chownow","order.online","linktr.ee"]),kind:/pdf/i.test(ct)||/\.pdf(?:$|[?#])/i.test(m.finalUrl||first.href)?"pdf":/html|text/i.test(ct)?(sameHost?"html-same-host":"third-party-platform"):/image/i.test(ct)?"image-only":(!sameHost?"third-party-platform":"other")};
      if(m.body&&/html|text/i.test(ct)){ const text=new TextDecoder().decode(m.body); mp.dietaryCounts=Object.fromEntries(Object.entries(markers).map(([k,re])=>[k,(text.match(re)||[]).length])); }
      r.menuPage=mp;
    } else r.menuPage={url:first.href,status:null,robotsAllowed:false,error:"robots.txt disallows"};
  }
  return r;
}

const results=new Array(venues.length); let cursor=0, done=0;
async function worker(){ while(true){const i=cursor++;if(i>=venues.length)return;results[i]=await one(venues[i]);done++;if(done%25===0)console.log(`${done}/${venues.length}`);}}
await Promise.all(Array.from({length:8},worker));
const ok=results.filter(r=>r.homepage.status>=200&&r.homepage.status<300).length, html=results.filter(r=>r.facts).length, menuFound=results.filter(r=>r.menuLinks.length).length, menuFetched=results.filter(r=>r.menuPage?.status>=200&&r.menuPage.status<300).length;
const countLinks=(field)=>Object.fromEntries([...reserveHosts,...deliveryHosts,...socialHosts].map(p=>[p,results.filter(r=>r[field]?.some(x=>x.platform===p)).length]).filter(([,n])=>n));
const kinds=Object.fromEntries(["html-same-host","pdf","image-only","third-party-platform","other"].map(k=>[k,results.filter(r=>r.menuPage?.kind===k&&r.menuPage.status>=200&&r.menuPage.status<300).length]));
const summary={total:results.length,homepage2xx:ok,homepageParsedHtml:html,robotsDisallowed:results.filter(r=>r.homepage.robotsAllowed===false).length,bodyTooLarge:results.filter(r=>r.homepage.tooLarge).length,anyJsonLd:results.filter(r=>r.facts?.types?.length).length,withCuisine:results.filter(r=>r.facts?.cuisine?.length).length,withPriceLevel:results.filter(r=>r.facts?.priceLevel).length,withHours:results.filter(r=>r.facts?.hours?.length).length,withRating:results.filter(r=>r.facts?.rating).length,withWheelchair:results.filter(r=>r.facts?.wheelchair!==undefined).length,withMenuUrlByExtractor:results.filter(r=>r.facts?.menuUrl).length,withDiscoveredMenuLinks:menuFound,menuFetch2xx:menuFetched,menuKinds:kinds,menuWithDietaryMarker:results.filter(r=>r.menuPage?.status>=200&&r.menuPage.dietaryCounts&&Object.values(r.menuPage.dietaryCounts).some(Number)).length,reservationPlatforms:countLinks("reservationLinks"),deliveryPlatforms:countLinks("deliveryLinks"),socialPlatforms:countLinks("socialLinks"),builders:Object.fromEntries(Object.keys(builders).map(k=>[k,results.filter(r=>r.builderHints.includes(k)).length]).filter(([,n])=>n))};
writeFileSync(`${DIR}/results.json`,JSON.stringify(results,null,2)); writeFileSync(`${DIR}/summary.json`,JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary));
