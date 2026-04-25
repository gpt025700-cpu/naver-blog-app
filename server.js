import { router, publicProcedure } from "@/server/_core/trpc";
import { z } from "zod";
import * as cheerio from "cheerio";
import { invokeLLM } from "@/server/_core/llm";

// Fetch HTML from a URL
async function fetchHtml(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
        "Referer": "https://www.naver.com/",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (e) {
    console.error("Fetch error:", e);
    return "";
  }
}

// Extract title from a URL
async function extractTitleFromUrl(url: string): Promise<string> {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const title =
      $("meta[property='og:title']").attr("content") ||
      $("meta[name='twitter:title']").attr("content") ||
      $("title").text() ||
      "";
    return title.trim().slice(0, 100);
  } catch (e) {
    console.error("Title extraction error:", e);
    return "";
  }
}

// Extract article content from Naver News URL
async function extractArticleContent(url: string): Promise<{ title: string; content: string; images: string[] }> {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const title =
      $("h1.title").text() ||
      $("h2.title").text() ||
      $("meta[property='og:title']").attr("content") ||
      "";
    const content =
      $("article").text() ||
      $("div.article_body").text() ||
      $("div#content").text() ||
      "";
    const images: string[] = [];
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || "";
      if (src && src.startsWith("http")) images.push(src);
    });
    return {
      title: title.trim(),
      content: content.trim().slice(0, 2000),
      images: images.slice(0, 5),
    };
  } catch (e) {
    console.error("Article extraction error:", e);
    return { title: "", content: "", images: [] };
  }
}

// 이미지 URL 필터링 (아이콘/로고/프로필 제외, 블로그 이미지만)
function isValidBlogImage(src: string): boolean {
  if (!src || !src.startsWith("http")) return false;
  const lower = src.toLowerCase();
  if (
    lower.includes("icon") ||
    lower.includes("logo") ||
    lower.includes("btn") ||
    lower.includes("profile") ||
    lower.includes("emoticon") ||
    lower.includes("sticker") ||
    lower.includes("banner") ||
    lower.includes("ad.") ||
    lower.includes("/ad/")
  ) return false;
  const cleanSrc = src.split("?")[0];
  return !!(
    cleanSrc.match(/\.(jpg|jpeg|png|webp|gif)$/i) ||
    src.includes("blogfiles") ||
    src.includes("postfiles") ||
    src.includes("pstatic.net") ||
    src.includes("blogimg") ||
    src.includes("mblogthumb")
  );
}

// Extract images from a single blog URL
async function extractBlogImages(url: string): Promise<string[]> {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const images: string[] = [];
    $("img").each((_, el) => {
      const src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-lazy-src") ||
        $(el).attr("data-original") ||
        "";
      if (isValidBlogImage(src) && !images.includes(src)) {
        images.push(src);
      }
    });
    return images.slice(0, 20);
  } catch (e) {
    console.error("Blog image extraction error:", e);
    return [];
  }
}

// ✅ 신규: 키워드로 네이버 블로그 검색 후 상위 블로그들에서 이미지 수집
async function extractKeywordBlogImages(keyword: string, maxImages = 30): Promise<string[]> {
  try {
    // 네이버 블로그 검색 결과 페이지 크롤링
    const searchUrl = `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(keyword)}&sm=tab_jum`;
    const html = await fetchHtml(searchUrl);
    const $ = cheerio.load(html);

    // 검색 결과에서 블로그 포스트 URL 추출
    const blogUrls: string[] = [];
    
    // 네이버 블로그 검색 결과 링크 패턴
    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (
        (href.includes("blog.naver.com") || href.includes("m.blog.naver.com")) &&
        !blogUrls.includes(href) &&
        blogUrls.length < 5
      ) {
        blogUrls.push(href);
      }
    });

    // 검색 결과 썸네일 이미지도 직접 수집
    const searchImages: string[] = [];
    $("img").each((_, el) => {
      const src =
        $(el).attr("src") ||
        $(el).attr("data-lazysrc") ||
        $(el).attr("data-src") ||
        "";
      if (isValidBlogImage(src) && !searchImages.includes(src)) {
        searchImages.push(src);
      }
    });

    console.log(`Found ${blogUrls.length} blog URLs, ${searchImages.length} search images for keyword: ${keyword}`);

    // 각 블로그 포스트에서 이미지 수집 (병렬 처리)
    const imageArrays = await Promise.allSettled(
      blogUrls.slice(0, 4).map((url) => extractBlogImages(url))
    );

    const allImages: string[] = [...searchImages];
    for (const result of imageArrays) {
      if (result.status === "fulfilled") {
        for (const img of result.value) {
          if (!allImages.includes(img)) allImages.push(img);
        }
      }
    }

    console.log(`Total keyword blog images collected: ${allImages.length}`);
    return allImages.slice(0, maxImages);
  } catch (e) {
    console.error("Keyword blog image extraction error:", e);
    return [];
  }
}

// ✅ 신규: 이미지 프록시 엔드포인트용 - 서버에서 이미지를 base64로 변환
async function fetchImageAsBase64(imageUrl: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://blog.naver.com/",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const mimeType = contentType.split(";")[0].trim();
    
    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Node.js Buffer를 사용해 base64 변환
    const base64 = Buffer.from(uint8Array).toString("base64");
    
    return { base64, mimeType };
  } catch (e) {
    console.error("Image fetch error:", imageUrl, e);
    return null;
  }
}

export const appRouter = router({
  blog: router({
    generate: publicProcedure
      .input(
        z.object({
          articleUrl: z.string().url("올바른 URL을 입력해주세요"),
          keyword: z.string().min(1, "키워드를 입력해주세요").max(50),
          relatedLinks: z.array(z.string().url()).optional(),
          optimizeForHomeFeed: z.boolean().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { articleUrl, keyword, relatedLinks = [], optimizeForHomeFeed = false } = input;

        let articleTitle = "";
        let articleContent = "";
        let articleImages: string[] = [];

        try {
          const extracted = await extractArticleContent(articleUrl);
          articleTitle = extracted.title;
          articleContent = extracted.content;
          articleImages = extracted.images;
        } catch (e) {
          console.error("Article extraction error:", e);
        }

        // 함께 보면 좋은 글 섹션 생성
        let relatedLinksSection = "";
        if (relatedLinks && relatedLinks.length > 0) {
          const relatedItems: Array<{ title: string; link: string }> = [];
          for (const link of relatedLinks) {
            if (link.trim()) {
              try {
                const title = await extractTitleFromUrl(link);
                relatedItems.push({ title: title || link, link });
              } catch (e) {
                relatedItems.push({ title: link, link });
              }
            }
          }
          relatedLinksSection = "\n\n【함께 보면 좋은 글】\n" + relatedItems.map((item) => item.link).join("\n");
        }

        // 제목 생성 프롬프트
        const titlePrompt = `당신은 네이버 홈 노출을 노리는 연예 콘텐츠 블로거입니다. 아래 정보를 바탕으로 다양한 스타일의 블로그 제목 5개를 생성해주세요.

키워드: ${keyword}
기사 제목: ${articleTitle || "없음"}
기사 내용 요약: ${articleContent ? articleContent.slice(0, 500) : "없음"}

제목 스타일:
1. 클릭 유도형: "${keyword}, 나도 놀래되다" 같은 느낌
2. 자극형: "${keyword}의 놀라운 이유" 같은 느낌
3. 반전형: "나도 모르는 ${keyword} 주의 사실" 같은 느낌
4. 비교형: "${keyword} vs 다른 대중스런 스타" 같은 느낌
5. 궁금증 유발형: "나도 모르는 ${keyword}의 도단한 진실" 같은 느낌

규칙:
1. 모든 제목은 반드시 "${keyword}"를 포함해야 합니다
2. 각 제목은 25-40자 사이로 작성하세요
3. 동일한 느낌의 제목은 중복되지 말아주세요
4. 네이버 블로그 스타일로 친근하고 자연스럽게 작성하세요
5. 단순 제목 5개만 출력하되, 각각 번호를 붙여서 출력하세요 (1. 제목, 2. 제목, ... 형식)
6. 다른 설명은 하지 마세요`;

        const titleResult = await invokeLLM({
          messages: [{ role: "user", content: [{ type: "text", text: titlePrompt }] }],
        });
        const titleText = titleResult.choices[0]?.message?.content;
        const generatedTitles = (typeof titleText === "string" ? titleText : "").trim();
        const titleLines = generatedTitles.split("\n").filter((line: string) => line.trim());
        const firstTitle = titleLines[0]?.replace(/^1\.\s*/, "").trim() || `${keyword}`;

        // 본문 생성 프롬프트
        const contentPrompt = `당신은 네이버 홈 피드 노출을 노리는 연예 콘텐츠 블로거입니다.

역할: 사용자가 붙여넣은 기사 내용을 기반으로, 뉴스가 아닌 자연스러운 블로그 글처럼 재작성합니다.
목표: 클릭률, 체류시간, 댓글 유도, 검색 노출 극대화

입력 정보:
키워드: ${keyword}
블로그 제목: ${firstTitle}
기사 내용: ${articleContent || "없음"}
참고 기사 제목: ${articleTitle || "없음"}

핵심 방향:
- 뉴스 요약처럼 쓰지 않는다
- 사람이 직접 쓴 블로그 글처럼 작성한다
- 정보 + 감정 + 반응이 자연스럽게 섞이도록 한다

본문 작성 규칙:
1. 전체 글은 공백 제외 약 10,000~15,000자 기준으로 작성
2. "도입부" 같은 표현 없이 바로 시작
3. 첫 문단은 2~3줄로 핵심 요약
4. 숫자, 반전, 반응 요소 중 최소 2개 포함
5. 키워드("${keyword}")를 8~15회 이상 자연스럽게 분산 배치

글 흐름:
1. 가볍게 시작 (공감 + 놀람)
2. 상황 설명
3. 핵심 포인트
4. 디테일 설명
5. 반응 정리
6. 추가 정보
7. 감정 마무리 + 질문

소제목 규칙:
- 반드시 소제목 사용 (최소 3개 이상)
- 숫자 사용 금지
- 모든 소제목은 서로 다르게 작성
- 각 소제목에만 특수기호 사용 (예: 【소제목】)
- 본문에는 이모지 사용 금지

문체:
- 블로그 말투 사용
- 문장 끝: ~했어요 / ~인데요 / ~느낌이었어요 / ~보셨나요

마지막 구성:
【함께 보면 좋은 글】
${relatedLinks.join("\n")}

해시태그 10~15개 작성 (#${keyword} 포함)

금지 사항:
- 기사 문장 그대로 복사 금지
- 딱딱한 뉴스체 금지
- AI 느낌 문장 금지
- 이모지 사용 금지 (소제목 제외)

출력: 본문만 출력하고 제목이나 다른 설명은 하지 마세요`;

        const contentResult = await invokeLLM({
          messages: [{ role: "user", content: [{ type: "text", text: contentPrompt }] }],
        });
        const contentText = contentResult.choices[0]?.message?.content;
        let generatedContent = (typeof contentText === "string" ? contentText : "").trim();

        if (relatedLinks && relatedLinks.length > 0 && !generatedContent.includes("함께 보면")) {
          generatedContent += relatedLinksSection;
        }

        // ✅ 수정: 기사 이미지 + 키워드 블로그 이미지 병렬 수집
        const [keywordImages] = await Promise.allSettled([
          extractKeywordBlogImages(keyword, 25),
        ]);

        const keywordImgs = keywordImages.status === "fulfilled" ? keywordImages.value : [];
        
        // 기사 이미지 + 키워드 블로그 이미지 합치기 (중복 제거)
        const allImages: string[] = [...articleImages];
        for (const img of keywordImgs) {
          if (!allImages.includes(img)) allImages.push(img);
        }

        console.log(`Final image count: ${allImages.length} (article: ${articleImages.length}, keyword: ${keywordImgs.length})`);

        return {
          titles: generatedTitles,
          selectedTitle: firstTitle,
          content: generatedContent,
          images: allImages.slice(0, 30), // 최대 30장
          articleTitle,
          keyword,
        };
      }),

    extractImages: publicProcedure
      .input(z.object({ url: z.string().url("올바른 URL을 입력해주세요") }))
      .mutation(async ({ input }) => {
        const images = await extractBlogImages(input.url);
        return { images };
      }),

    // ✅ 신규: 키워드로 블로그 이미지만 별도 수집
    extractKeywordImages: publicProcedure
      .input(z.object({
        keyword: z.string().min(1).max(50),
        maxImages: z.number().min(1).max(50).optional(),
      }))
      .mutation(async ({ input }) => {
        const images = await extractKeywordBlogImages(input.keyword, input.maxImages ?? 30);
        return { images };
      }),

    // ✅ 신규: 이미지 프록시 - 앱에서 직접 다운로드 불가한 이미지를 서버에서 base64로 변환
    proxyImage: publicProcedure
      .input(z.object({ imageUrl: z.string().url() }))
      .mutation(async ({ input }) => {
        const result = await fetchImageAsBase64(input.imageUrl);
        if (!result) {
          throw new Error("이미지를 가져올 수 없습니다.");
        }
        return result; // { base64: string, mimeType: string }
      }),
  }),
});

export type AppRouter = typeof appRouter;
