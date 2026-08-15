#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "policies.json");
const JS_PATH = path.join(DATA_DIR, "policies.js");
const REPORT_PATH = path.join(DATA_DIR, "update-report.json");

const TODAY = new Date().toISOString().slice(0, 10);
const API = "https://www.youthcenter.go.kr/go/ythip/getPlcy";

function uniq(xs){
  return [...new Set(xs.filter(Boolean))];
}

function stableId(s){
  return String(s || "")
    .normalize("NFKD")
    .replace(/[^\w가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64);
}

function toDate(s){
  if(!s) return null;
  const m = String(s).match(/(20\d{2})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})/);
  if(!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function inferRegion(item){
  const text = [item.zipCd, item.rgtrUpInstCdNm, item.rgtrHghrkInstCdNm, item.sprvsnInstCdNm, item.operInstCdNm].join(" ");
  if(/서울/.test(text)) return "서울";
  if(/경기|경기도|수원|성남|고양|용인|부천|안산|안양|화성|평택|시흥|김포|광명|군포|하남|오산|이천|안성|의왕|양평|여주|과천|가평|연천|포천|동두천|구리|남양주|파주|의정부|양주/.test(text)) return "경기";
  if(/인천/.test(text)) return "인천";
  return "전국";
}

function inferCat(item){
  const l = item.lclsfNm || "";
  const m = item.mclsfNm || "";
  const k = `${l} ${m} ${item.plcyKywdNm || ""} ${item.plcyNm || ""}`;
  if(/주거|전월세|주택|기숙사|임대/.test(k)) return "주거";
  if(/취업|일자리|재직|인턴|채용|근로/.test(k)) return "취업";
  if(/창업/.test(k)) return "창업";
  if(/교육|역량|교육비|장학|학자금/.test(k)) return "교육";
  if(/금융|자산|저축|대출|신용|금리/.test(k)) return "자산";
  if(/문화|예술/.test(k)) return "문화";
  if(/복지|생활|건강|상담/.test(k)) return "복지";
  if(/참여|권리|교류/.test(k)) return "참여";
  return l || "기타";
}

function inferTarget(item){
  const t = `${item.plcyNm || ""} ${item.plcyExplnCn || ""} ${item.addAplyQlfcCndCn || ""} ${item.schoolCd || ""} ${item.jobCd || ""}`;
  const out = [];
  if(/대학|학생|학부|대학원|학자금|장학/.test(t)) out.push("학생");
  if(/재직|근로|직장|중소기업|사업소득|근로소득/.test(t)) out.push("직장인");
  if(/구직|미취업|취업준비|면접|채용/.test(t)) out.push("구직");
  return out.length ? out : ["학생", "직장인", "구직"];
}

function inferRules(item){
  const min = Number(item.sprtTrgtMinAge);
  const max = Number(item.sprtTrgtMaxAge);
  const rules = {};
  if(Number.isFinite(min) || Number.isFinite(max)){
    rules.age = {};
    if(Number.isFinite(min)) rules.age.min = min;
    if(Number.isFinite(max)) rules.age.max = max;
  }
  const region = inferRegion(item);
  if(region === "서울" || region === "경기" || region === "인천") rules.region = [region];
  const text = `${item.plcyExplnCn || ""} ${item.addAplyQlfcCndCn || ""} ${item.earnEtcCn || ""} ${item.ptcpPrpTrgtCn || ""}`.trim();
  if(text) rules.unsure = [`세부 자격 확인 필요 — ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`];
  return rules;
}

function normalizeApiItem(item){
  const name = item.plcyNm || item.policyName || "";
  const id = `ontong-${item.plcyNo || stableId(name)}`;
  const open = toDate(item.aplyYmd) || toDate(item.bizPrdBgngYmd);
  const close = (() => {
    const dates = String(item.aplyYmd || "").match(/20\d{2}[.\-/년\s]*\d{1,2}[.\-/월\s]*\d{1,2}/g);
    return dates && dates.length > 1 ? toDate(dates[dates.length - 1]) : toDate(item.bizPrdEndYmd);
  })();
  return {
    id,
    name,
    org: item.sprvsnInstCdNm || item.operInstCdNm || item.rgtrInstCdNm || "기관 확인 필요",
    region: inferRegion(item),
    target: inferTarget(item),
    cat: inferCat(item),
    open,
    close,
    always: /상시|수시/.test(String(item.aplyYmd || item.bizPrdEtcCn || "")) || (!open && !close),
    amount: item.plcySprtCn || "지원내용 확인 필요",
    elig: item.addAplyQlfcCndCn || item.plcyExplnCn || "자격요건 확인 필요",
    url: item.aplyUrlAddr || item.refUrlAddr1 || item.refUrlAddr2 || "https://www.youthcenter.go.kr",
    checked: TODAY,
    confidence: "verify",
    note: item.sbmsnDcmntCn ? `제출서류: ${String(item.sbmsnDcmntCn).slice(0, 80)}` : "온통청년 API 자동 수집 항목",
    source: "ontong-youth-policy-api",
    upstreamId: item.plcyNo || null,
    updatedAt: item.lastMdfcnDt || item.frstRegDt || null,
    rules: inferRules(item)
  };
}

function mergePolicies(base, incoming){
  const byId = new Map(base.map(p => [p.id, p]));
  const added = [];
  const updated = [];
  for(const p of incoming){
    if(!p.id || !p.name) continue;
    if(byId.has(p.id)){
      const prev = byId.get(p.id);
      byId.set(p.id, { ...prev, ...p, rules: { ...(prev.rules || {}), ...(p.rules || {}) } });
      updated.push(p.id);
    } else {
      byId.set(p.id, p);
      added.push(p.id);
    }
  }
  return { policies: [...byId.values()], added, updated };
}

function validate(policies){
  const errors = [];
  const ids = new Set();
  const required = ["id", "name", "org", "region", "target", "cat", "amount", "elig", "url", "checked", "confidence", "rules"];
  policies.forEach((p, i) => {
    for(const k of required){
      if(p[k] == null || p[k] === "") errors.push(`[${i}] ${p.id || "(no id)"} missing ${k}`);
    }
    if(ids.has(p.id)) errors.push(`duplicate id: ${p.id}`);
    ids.add(p.id);
    if(!Array.isArray(p.target)) errors.push(`${p.id} target must be array`);
    if(typeof p.rules !== "object" || Array.isArray(p.rules)) errors.push(`${p.id} rules must be object`);
  });
  return errors;
}

async function fetchOntong(){
  const key = process.env.YOUTH_POLICY_API_KEY;
  if(!key) return { skipped: "YOUTH_POLICY_API_KEY is not set", items: [] };
  const items = [];
  for(let pageNum = 1; pageNum <= Number(process.env.YOUTH_POLICY_MAX_PAGES || 5); pageNum++){
    const url = new URL(API);
    url.searchParams.set("apiKeyNm", key);
    url.searchParams.set("pageNum", String(pageNum));
    url.searchParams.set("pageSize", String(process.env.YOUTH_POLICY_PAGE_SIZE || 100));
    url.searchParams.set("pageType", "1");
    url.searchParams.set("rtnType", "json");
    const res = await fetch(url);
    if(!res.ok) throw new Error(`Ontong API ${res.status} ${res.statusText}`);
    const json = await res.json();
    const list = json.youthPolicyList || json.result?.youthPolicyList || json.data || [];
    const arr = Array.isArray(list) ? list : [list].filter(Boolean);
    if(!arr.length) break;
    items.push(...arr.map(normalizeApiItem));
  }
  return { items };
}

async function main(){
  await fs.mkdir(DATA_DIR, { recursive: true });
  const base = JSON.parse(await fs.readFile(DB_PATH, "utf8"));
  const fetched = await fetchOntong();
  const { policies, added, updated } = mergePolicies(base.policies || base, fetched.items);
  const errors = validate(policies);
  if(errors.length){
    console.error(errors.join("\n"));
    process.exit(1);
  }
  const db = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: uniq(policies.map(p => p.source || "manual")),
    policies
  };
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2) + "\n");
  await fs.writeFile(JS_PATH,
    `window.POLICY_DB_META = ${JSON.stringify({
      schemaVersion: db.schemaVersion,
      generatedAt: db.generatedAt,
      sources: db.sources
    }, null, 2)};\nwindow.POLICY_DB = ${JSON.stringify(policies, null, 2)};\n`);
  await fs.writeFile(REPORT_PATH, JSON.stringify({
    generatedAt: db.generatedAt,
    total: policies.length,
    fetched: fetched.items.length,
    added,
    updated,
    skipped: fetched.skipped || null
  }, null, 2) + "\n");
  console.log(`policies=${policies.length} fetched=${fetched.items.length} added=${added.length} updated=${updated.length}`);
  if(fetched.skipped) console.log(`skip: ${fetched.skipped}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
