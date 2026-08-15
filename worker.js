/* Cloudflare Worker — 정적 자산 서빙 + 익명 사용 통계
 *
 * 설계 원칙
 *  1. 개인 프로필은 절대 서버로 오지 않는다. 오는 건 거친 버킷뿐이다
 *     (시도 단위 지역 / 신분 / 연령대 / 판정 개수). 생년·학교·특이사항은 클라이언트에서 버린다.
 *  2. 사용자 식별자를 영속시키지 않는다. 날짜별로 회전하는 해시를 써서
 *     "그날의 순 방문"만 세고 다음 날이면 연결이 끊긴다.
 *  3. 통계가 실패해도 사이트는 멀쩡해야 한다. KV 바인딩이 없으면 조용히 통과한다.
 *
 * 카운터 대신 이벤트를 개별 키로 적는다. KV 는 read-modify-write 경합에 취약해서
 * 카운터를 쓰면 동시 요청에서 값이 유실된다. 읽을 때 집계하는 편이 정확하다.
 */

const DAY_MS = 86400000;

async function dailyToken(req) {
  // IP + UA + 날짜를 해시. 같은 날 같은 기기는 같은 값, 날짜가 바뀌면 연결이 끊긴다.
  const ip = req.headers.get("cf-connecting-ip") || "";
  const ua = req.headers.get("user-agent") || "";
  const day = new Date().toISOString().slice(0, 10);
  const buf = new TextEncoder().encode(ip + "|" + ua + "|" + day);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash).slice(0, 8)]
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

const ALLOWED = {
  region: ["서울", "경기", "인천", "기타"],
  status: ["대학생", "대학원생", "직장인", "구직중", "프리랜서"],
  age:    ["10대", "20대초", "20대후", "30대초", "30대후", "40대+"]
};
const pick = (v, list) => (list.includes(v) ? v : null);

async function record(env, req, body) {
  if (!env.STATS) return;                       // 바인딩 없으면 조용히 통과
  const day = new Date().toISOString().slice(0, 10);
  const tok = await dailyToken(req);
  const t = body.t;

  const ev = { t, day, tok };
  if (t === "profile") {
    ev.region = pick(body.r, ALLOWED.region);
    ev.status = pick(body.s, ALLOWED.status);
    ev.age    = pick(body.a, ALLOWED.age);
    const v = body.v || {};
    ev.pass  = Math.min(99, Number(v.p) || 0);
    ev.maybe = Math.min(99, Number(v.m) || 0);
    ev.fail  = Math.min(99, Number(v.f) || 0);
    ev.zero  = ev.pass === 0;                   // ✅ 0건 = 데이터 구멍 신호
  } else if (t === "click") {
    ev.id = String(body.id || "").slice(0, 40);
  } else if (t !== "view") {
    return;
  }

  // 키에 난수를 붙여 경합 없이 append-only 로 쌓는다. 90일 뒤 자동 삭제.
  const key = `e:${day}:${crypto.randomUUID()}`;
  await env.STATS.put(key, JSON.stringify(ev), { expirationTtl: 90 * 24 * 3600 });
}

async function stats(env, days) {
  if (!env.STATS) return { error: "KV 바인딩(STATS)이 설정되지 않았습니다" };

  const wanted = [];
  for (let i = 0; i < days; i++) {
    wanted.push(new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10));
  }

  const evs = [];
  for (const day of wanted) {
    let cursor;
    do {
      const page = await env.STATS.list({ prefix: `e:${day}:`, cursor, limit: 1000 });
      const vals = await Promise.all(page.keys.map(k => env.STATS.get(k.name, "json")));
      vals.forEach(v => v && evs.push(v));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }

  const bump = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
  const out = {
    기간: wanted[wanted.length - 1] + " ~ " + wanted[0],
    방문: 0, 순방문: 0, 프로필입력: 0, 원문클릭: 0,
    지역별: {}, 신분별: {}, 연령대별: {},
    결과없음: { 건수: 0, 조건: {} },
    인기정책: {}
  };
  const uniq = new Set();

  for (const e of evs) {
    uniq.add(e.tok);
    if (e.t === "view") out.방문++;
    else if (e.t === "click") { out.원문클릭++; bump(out.인기정책, e.id); }
    else if (e.t === "profile") {
      out.프로필입력++;
      bump(out.지역별, e.region);
      bump(out.신분별, e.status);
      bump(out.연령대별, e.age);
      if (e.zero) {
        out.결과없음.건수++;
        bump(out.결과없음.조건, [e.region, e.status].filter(Boolean).join(" ") || "미상");
      }
    }
  }
  out.순방문 = uniq.size;

  const top = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 15));
  out.인기정책 = top(out.인기정책);
  out.결과없음.조건 = top(out.결과없음.조건);
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/api/e" && req.method === "POST") {
      try {
        const body = await req.json();
        ctx.waitUntil(record(env, req, body));   // 응답을 막지 않는다
      } catch (e) { /* 잘못된 본문은 무시 */ }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/stats") {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
      const data = await stats(env, days);
      return new Response(JSON.stringify(data, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8",
                   "cache-control": "no-store" }
      });
    }

    return env.ASSETS.fetch(req);   // 그 외는 전부 정적 자산
  }
};
