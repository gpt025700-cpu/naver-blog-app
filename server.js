const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const cheerio = require("cheerio");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const jobs = new Map();

// 헤더 설정
const NAV_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9",
  "Referer": "https://www.naver.com/",
};

// HTML 가져오기
async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: NAV_HEADERS, timeout: 8000 });
    if (!res.ok) return "";
    return await res.text();
  } catch { return ""; }
}

// 기사 내용 추출
async function extractArticle(url) {
  const html = await fetchHtml(url);
  if (!html) return { title: "", content: "" };
  const $ = cheerio.load(html);
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("h1").first().text() ||
    $("title").text() || "";
  const content =
    $("#articleBodyContents").text() ||
    $("article").text() ||
    $(".article_body").text() ||
    $("div#content").text() || "";
  return {
    title: title.trim().slice(0, 200),
    content: content.replace(/\s+/g, " ").trim().slice(0, 3000),
  };
}

// 관련 URL 제목 가져오기
async function fetchPageTitle(url) {
  try {
    const html = await fetchHtml(url);
    if (!html) return "";
    const $ = cheerio.load(html);
    return (
      $("meta[property='og:title']").attr("content") ||
      $("title").text() || ""
    ).trim().slice(0, 100);
  } catch { return ""; }
}

// Gemini API 호출
async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API 오류 (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// 이미지 유효성 검사
async function isValidImage(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { ...NAV_HEADERS, Referer: "https://blog.naver.com/" },
      timeout: 4000,
    });
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") || "";
    const cl = parseInt(res.headers.get("content-length") || "0");
    return ct.startsWith("image/") && (cl === 0 || cl > 4096);
  } catch { return false; }
}

// 이미지 필터링
function isValidImageUrl(src) {
  if (!src || !src.startsWith("http")) return false;
  const lower = src.toLowerCase();
  const blocked = ["icon", "logo", "btn", "profile", "emoticon", "sticker", "banner", "/ad/", "favicon", "arrow", "bullet"];
  if (blocked.some(b => lower.includes(b))) return false;
  const clean = src.split("?")[0];
  return !!(
    clean.match(/\.(jpg|jpeg|png|webp|gif)$/i) ||
    src.includes("blogfiles") ||
    src.includes("postfiles") ||
    src.includes("pstatic.net") ||
    src.includes("blogimg") ||
    src.includes("mblogthumb") ||
    src.includes("imgnews") ||
    src.includes("newsimg")
  );
}

// 키워드로 이미지 수집
async function collectImages(keywords) {
  const allImages = [];
  const seen = new Set();

  for (const kw of keywords.slice(0, 3)) {
    const encoded = encodeURIComponent(kw);
    const urls = [
      `https://search.naver.com/search.naver?where=news&query=${encoded}`,
      `https://search.naver.com/search.naver?where=blog&query=${encoded}`,
    ];

    for (const searchUrl of urls) {
      const html = await fetchHtml(searchUrl);
      if (!html) continue;
      const $ = cheerio.load(html);
      $("img").each((_, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazysrc") || "";
        if (isValidImageUrl(src) && !seen.has(src)) {
          seen.add(src);
          allImages.push(src);
        }
      });
    }
  }

  // 유효성 검사 (병렬, 최대 30개)
  const candidates = allImages.slice(0, 60);
  const results = await Promise.allSettled(
    candidates.map(async (url) => {
      const valid = await isValidImage(url);
      return valid ? url : null;
    })
  );

  return results
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value)
    .slice(0, 40);
}

// 블로그 글 생성
async function generateBlogPost(articleUrl, keyword, relatedUrls) {
  const article = await extractArticle(articleUrl);

  // 관련 URL 제목 가져오기
  const relatedTitles = await Promise.all(
    relatedUrls.filter(Boolean).map(async (url) => {
      const title = await fetchPageTitle(url);
      return { url, title };
    })
  );

  const relatedSection = relatedTitles.length > 0
    ? `\n함께 읽으면 좋은 글\n\n${relatedTitles.map(r => r.url).join("\n")}`
    : "";

  // 제목 생성
  const titlePrompt = `당신은 네이버 블로그 작가입니다.
키워드: ${keyword}
참고 기사 제목: ${article.title || "없음"}

아래 규칙으로 블로그 제목 1개만 만들어주세요.
- 핵심 키워드 "${keyword}"가 제목 맨 앞에 위치
- 25~40자
- 사람들이 클릭하고 싶게 자연스럽고 흥미롭게
- 숫자, 반전, 궁금증 유발 요소 포함
- 뉴스 제목처럼 딱딱하게 쓰지 말것
- 제목만 출력, 번호나 설명 없이`;

  const title = (await callGemini(titlePrompt)).trim();

  // 본문 생성
  const contentPrompt = `당신은 네이버 블로그 작가입니다.

키워드: ${keyword}
제목: ${title}
참고 기사 내용: ${article.content || "없음"}

아래 규칙으로 블로그 본문을 작성하세요.

문체 규칙:
- 말투: ~인데요 / ~했어요 / ~이었습니다 / ~않나요? / ~같아요
- 소제목 앞뒤 특수기호 사용 금지, 소제목은 텍스트만
- 본문 전체 이모지 사용 금지
- 공백 제외 1,500~1,800자 (절대 넘지 말것)
- 키워드 "${keyword}"를 문장 흐름에 맞게 자연스럽게 15~20회 배치
- 뉴스 기사 말투 절대 금지
- 사람이 직접 쓴 것처럼 친근하고 자연스럽게
- AI 느낌 문장 금지
- 한 문단은 2~3문장으로 구성, 내용이 바뀔 때만 줄바꿈
- 소제목 앞뒤 빈 줄 하나씩

글 구조:
1. 첫 문단: 2~3줄로 핵심 요약, 독자 관심 끌기
2. 소제목 4~5개로 내용 나누기
3. 각 소제목 아래 2~3개 짧은 문단
4. 마지막: 독자에게 질문 한 개
5. "오늘도 읽어주셔서 감사합니다." 로 마무리
${relatedSection ? `6. 마지막에 아래 내용 포함:\n${relatedSection}` : ""}

해시태그:
- 본문 맨 마지막에 추가
- 키워드 기반 네이버 검색에 잘 걸리는 태그 15개
- 형식: #${keyword} #관련태그1 #관련태그2 한 줄로 나열

본문만 출력, 제목 출력 금지`;

  const content = (await callGemini(contentPrompt)).trim();

  // 이미지 검색용 키워드 추출
  const kwPrompt = `다음 블로그 본문에서 이미지 검색에 쓸 핵심 키워드 3개를 추출해줘.
인물명, 장소명, 사건명 위주로.
쉼표로 구분해서 키워드만 출력.

본문: ${content.slice(0, 500)}`;
  const kwResult = (await callGemini(kwPrompt)).trim();
  const keywords = kwResult.split(/[,，\n]/).map(k => k.trim()).filter(Boolean).slice(0, 3);
  if (!keywords.includes(keyword)) keywords.unshift(keyword);

  return { title, content, keywords };
}

// ─── API 라우트 ───────────────────────────────────────

// 글 생성 시작
app.post("/api/blog/generate", async (req, res) => {
  const { articleUrl, keyword, relatedUrls = [] } = req.body;
  if (!articleUrl || !keyword) {
    return res.status(400).json({ error: "articleUrl과 keyword는 필수입니다." });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  jobs.set(jobId, { status: "pending" });
  res.json({ jobId });

  // 백그라운드 생성
  (async () => {
    try {
      const result = await generateBlogPost(articleUrl, keyword, relatedUrls);
      jobs.set(jobId, { status: "completed", ...result });
    } catch (e) {
      jobs.set(jobId, { status: "failed", error: e.message });
    }
    // 1시간 후 삭제
    setTimeout(() => jobs.delete(jobId), 3600000);
  })();
});

// 글 생성 상태 확인
app.get("/api/blog/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job을 찾을 수 없습니다." });
  res.json(job);
});

// 이미지 검색
app.post("/api/images/search", async (req, res) => {
  const { keywords = [] } = req.body;
  try {
    const images = await collectImages(Array.isArray(keywords) ? keywords : [keywords]);
    res.json({ images });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 이미지 다운로드 프록시
app.post("/api/images/download", async (req, res) => {
  const { url } = req.body;
  try {
    const imgRes = await fetch(url, {
      headers: { ...NAV_HEADERS, Referer: "https://blog.naver.com/" },
      timeout: 8000,
    });
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
    const buffer = await imgRes.buffer();
    const ct = imgRes.headers.get("content-type") || "image/jpeg";
    res.json({
      base64: buffer.toString("base64"),
      mimeType: ct.split(";")[0].trim(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
