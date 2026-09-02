import { readFile, writeFile } from "node:fs/promises";
import { parseWebsite, robotsAllows } from "/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts";

const DIR = "/tmp/codex-crawl.iu90UN/berlin-mitte-B";
const UA = "spokes-research/0.2 (+https://github.com/schlessera/webmcp-hackathon; structured-data survey)";
const TIMEOUT = 12_000, MAX = 2_000_000, CONCURRENCY = 8;
const MENU_RE = /menu|menü|speisekarte|(?:^|\W)karte(?:\W|$)|carte|getränke|drinks?|food|essen|mittag|lunch|dinner|\.pdf(?:\W|$)/i;
const RESERVATION = ["opentable","resy","quandoo","thefork","sevenrooms","tock"];
const DELIVERY = ["lieferando","wolt","ubereats","doordash","deliveroo","grubhub"];
const SOCIAL = ["instagram","facebook"];
const BUILDERS = {
  wix: /wixstatic|wix\.com|wix-code|wixsite/i, squarespace: /static1\.squarespace|squarespace/i,
  wordpress: /wp-content|wp-includes|wordpress/i, shopify: /cdn\.shopify|shopify\.com|Shopify\.theme/i,
  webflow: /webflow\.com|data-wf-(?:page|site)/i, jimdo: /jimdo|jimdofree/i,
  typo3: /typo3/i, drupal: /drupalSettings|sites\/default\/files/i, joomla: /\/media\/system\/js|joomla/i,
  weebly: /weebly/i, duda: /duda\.co|dmcdn\.net|data-dm-url/i, godaddy: /godaddy|secureservercdn/i,
};
const DIET = {
  vegan: /\bvegan\b/gi, vegetarian: /\b(?:vegetarian|vegetarisch)\b/gi,
  glutenFree: /\b(?:gluten[ -]?free|glutenfrei)\b/gi, lactoseFree: /\b(?:lactose[ -]?free|laktosefrei)\b/gi,
  halal: /\bhalal\b/gi, allergen: /\b(?:allergen|allergene)\w*/gi,
  vParen: /\(v\)/gi, vg: /(?:^|\W)vg(?:\W|$)/gi,
};

const clean = s => s.replace(/<[^>]*>/g," ").replace(/&(?:nbsp|amp|quot|#39);/gi," ").replace(/\s+/g," ").trim();
const snippet = (s, i, n=200) => clean(s.slice(Math.max(0,i-70), i+130)).slice(0,n);
function normalize(raw) { try { const s = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`; return new URL(s).toString(); } catch { return null; } }
function platform(url, names) { const s = url.toLowerCase(); return names.find(n => s.includes(n)) ?? null; }
function anchors(html, base) {
  const out=[]; const re=/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi; let m;
  while ((m=re.exec(html))) {
    const h=/\bhref\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/i.exec(m[1]); if(!h) continue;
    try { const url=new URL(h[1]??h[2],base).toString(); out.push({url,text:clean(m[2]).slice(0,160),html:snippet(html,m.index)}); } catch {}
  }
  return out;
}
async function body(res, text=false) {
  const declared=Number(res.headers.get("content-length"));
  if (declared > MAX) { try { await res.body?.cancel(); } catch {} return {tooLarge:true,bytes:declared}; }
  if (!res.body) return {bytes:0,data:text?"":new Uint8Array()};
  const reader=res.body.getReader(), chunks=[]; let bytes=0;
  while(true){const {done,value}=await reader.read(); if(done)break; bytes+=value.byteLength; if(bytes>MAX){await reader.cancel();return{tooLarge:true,bytes};} chunks.push(value);}
  const all=new Uint8Array(bytes); let p=0; for(const c of chunks){all.set(c,p);p+=c.length;}
  return {bytes,data:text?new TextDecoder().decode(all):all};
}
async function timedFetch(url, accept) { return fetch(url,{headers:{"user-agent":UA,accept},redirect:"follow",signal:AbortSignal.timeout(TIMEOUT)}); }
const robotCache=new Map();
async function allowed(u) {
  const origin=u.origin;
  if(!robotCache.has(origin)) robotCache.set(origin,(async()=>{try{const r=await timedFetch(`${origin}/robots.txt`,"text/plain");if(!r.ok)return null;const b=await body(r,true);return b.tooLarge?null:b.data.slice(0,100000);}catch{return null;}})());
  const txt=await robotCache.get(origin); return txt==null || robotsAllows(txt,u.pathname||"/");
}
function evidence(html) {
  const pats=[/openingHoursSpecification/i,/hasMenu|"menu"\s*:/i,/servesCuisine/i,/priceRange/i,/aggregateRating/i,/acceptsReservations/i,/amenityFeature/i,/@type["']?\s*:\s*\[/i,/@graph/i];
  return pats.flatMap(re=>{const m=re.exec(html);return m?[{pattern:re.source,snippet:snippet(html,m.index)}]:[];}).slice(0,10);
}
async function one(v) {
  const started=Date.now(), target=normalize(v.website), r={ref:v.ref,name:v.name,distanceM:v.distanceM,website:v.website,target,status:null,finalUrl:null,error:null,bytes:null,contentType:null,robotsAllowed:null,builderHints:[],facts:null,menuLinks:[],reservationLinks:[],deliveryLinks:[],socialLinks:[],evidence:[],menuFetch:null,ms:null};
  if(!target){r.error="invalid URL";return r;}
  try{
    const u=new URL(target); r.robotsAllowed=await allowed(u); if(!r.robotsAllowed){r.error="robots.txt disallows";return r;}
    const res=await timedFetch(target,"text/html,application/xhtml+xml"); r.status=res.status;r.finalUrl=res.url;r.contentType=res.headers.get("content-type")??"";
    const isText=/html|xml|text/i.test(r.contentType); const b=await body(res,isText);r.bytes=b.bytes;
    if(b.tooLarge){r.error="body over 2 MB";return r;} if(!isText){r.error="homepage not HTML/text";return r;}
    const html=b.data; r.builderHints=Object.entries(BUILDERS).filter(([,x])=>x.test(html)).map(([k])=>k);
    r.facts=parseWebsite(html,res.url||target,new Date().toISOString()); r.evidence=evidence(html);
    const as=anchors(html,res.url||target);
    r.menuLinks=as.filter(a=>MENU_RE.test(`${a.url} ${a.text}`));
    r.reservationLinks=as.map(a=>({...a,platform:platform(a.url,RESERVATION)})).filter(a=>a.platform);
    r.deliveryLinks=as.map(a=>({...a,platform:platform(a.url,DELIVERY)})).filter(a=>a.platform);
    r.socialLinks=as.map(a=>({...a,platform:platform(a.url,SOCIAL)})).filter(a=>a.platform);
    if(r.menuLinks.length){
      const base=new URL(res.url||target); const chosen=[...r.menuLinks].sort((a,b)=>Number(new URL(b.url).host===base.host)-Number(new URL(a.url).host===base.host))[0];
      const mu=new URL(chosen.url); const mf={url:chosen.url,sameHost:mu.host===base.host,platform:platform(chosen.url,[...RESERVATION,...DELIVERY]),status:null,finalUrl:null,contentType:null,bytes:null,tooLarge:false,error:null,dietaryCounts:null};r.menuFetch=mf;
      try{if(!(await allowed(mu))){mf.error="robots.txt disallows";}else{const mr=await timedFetch(chosen.url,"text/html,text/plain,application/pdf,image/*");mf.status=mr.status;mf.finalUrl=mr.url;mf.contentType=mr.headers.get("content-type")??"";const text=/html|text|xml|json/i.test(mf.contentType);const mb=await body(mr,text);mf.bytes=mb.bytes;mf.tooLarge=!!mb.tooLarge;if(!mb.tooLarge&&text){mf.dietaryCounts=Object.fromEntries(Object.entries(DIET).map(([k,re])=>[k,[...mb.data.matchAll(re)].length]));}}}catch(e){mf.error=`${e.name}: ${e.message}`.slice(0,160);}
    }
  }catch(e){r.error=`${e.name}: ${e.message}`.slice(0,160);}finally{r.ms=Date.now()-started;}
  return r;
}
const venues=JSON.parse(await readFile(`${DIR}/venues.json`,"utf8")); const results=new Array(venues.length); let next=0,done=0;
await Promise.all(Array.from({length:CONCURRENCY},async()=>{while(true){const i=next++;if(i>=venues.length)return;results[i]=await one(venues[i]);done++;if(done%25===0)console.log(`${done}/${venues.length}`);}}));
const countBy=(xs,key)=>Object.fromEntries([...new Set(xs.map(x=>x[key]).filter(Boolean))].sort().map(k=>[k,xs.filter(x=>x[key]===k).length]));
const menus=results.map(x=>x.menuFetch).filter(Boolean), fetchedMenus=menus.filter(x=>x.status!=null);
const categories={sameHostHtml:0,pdf:0,imageOnly:0,thirdParty:0,other:0};
for(const m of fetchedMenus){if(!m.sameHost)categories.thirdParty++;else if(/pdf/i.test(m.contentType)||/\.pdf(?:$|[?#])/i.test(m.finalUrl||m.url))categories.pdf++;else if(/image/i.test(m.contentType))categories.imageOnly++;else if(/html|text/i.test(m.contentType))categories.sameHostHtml++;else categories.other++;}
const summary={venues:results.length,robotsDisallowed:results.filter(x=>x.robotsAllowed===false).length,httpResponses:results.filter(x=>x.status!=null).length,http200:results.filter(x=>x.status===200).length,htmlParsed:results.filter(x=>x.facts).length,jsonLdAny:results.filter(x=>x.facts?.types?.length).length,structured:{cuisine:results.filter(x=>x.facts?.cuisine).length,priceLevel:results.filter(x=>x.facts?.priceLevel).length,hours:results.filter(x=>x.facts?.hours).length,rating:results.filter(x=>x.facts?.rating).length,wheelchair:results.filter(x=>x.facts?.wheelchair!==undefined).length,menuUrl:results.filter(x=>x.facts?.menuUrl).length,reservationsUrl:results.filter(x=>x.facts?.reservationsUrl).length,description:results.filter(x=>x.facts?.description).length},menuLinks:results.filter(x=>x.menuLinks.length).length,menuFetchesAttempted:menus.length,menuFetchResponses:fetchedMenus.length,menuCategories:categories,menuDietaryAny:menus.filter(x=>x.dietaryCounts&&Object.values(x.dietaryCounts).some(Boolean)).length,builderHints:Object.fromEntries(Object.keys(BUILDERS).map(k=>[k,results.filter(x=>x.builderHints.includes(k)).length]).filter(([,n])=>n)),reservationPlatforms:countBy(results.flatMap(x=>x.reservationLinks),"platform"),deliveryPlatforms:countBy(results.flatMap(x=>x.deliveryLinks),"platform"),socialPlatforms:countBy(results.flatMap(x=>x.socialLinks),"platform")};
await writeFile(`${DIR}/results.json`,JSON.stringify(results,null,2));await writeFile(`${DIR}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
