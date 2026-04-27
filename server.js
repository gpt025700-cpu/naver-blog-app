const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const jobs = new Map();

// ── 유틸 ──────────────────────────────────────────────

function isSj(line) {
  const t = line.trim();
  if (!t || t.length < 5 || t.length > 35) return false;
  if (/[.。]$/.test(t)) return false;
  const skipWords = ['#','http','스푼','오늘도','함께','여러분','오늘'];
  if (skipWords.some(w => t.startsWith(w))) return false;
  if (/^\d+[.。]\s/.test(t)) return false;
  return true;
}

function postProcessBody(text) {
  if (!text) return text;

  // 불필요한 태그 제거
  text = text.replace(/^\[(.+)\]$/gm, '$1');
  text = text.replace(/^소제목\s*[(\uff08][^)\uff09]*[)\uff09]\s*$/gm, '');
  text = text.replace(/^소제목\s*/gm, '');
  text = text.replace(/^\d+[.。]\s+/gm, '');

  const lines = text.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (isSj(trimmed)) {
      if (result.length > 0 && result[result.length - 1] !== '') result.push('');
      result.push(trimmed);
      result.push('');
    } else {
      result.push(lines[i]);
    }
  }

  // 연속 빈줄 제거
  const final = [];
  for (let i = 0; i < result.length; i++) {
    if (result[i] === '' && final[final.length - 1] === '') continue;
    final.push(result[i]);
  }

  return final.join('\n').trim();
}

function cleanHashtags(raw, keyword) {
  if (!raw) return `#${keyword}`;
  const tags = raw.split(/[\s,]+/).filter(t => t.startsWith('#'));
  const unique = [...new Set(tags)];
  if (!unique.includes(`#${keyword}`)) unique.unshift(`#${keyword}`);
  return unique.slice(0, 15).join(' ');
}

function countChars(text) {
  const beforeSection = text.split('함께 읽으면 좋은 글')[0];
  return {
    withSpace: beforeSection.length,
    noSpace: beforeSection.replace(/\s/g, '').length
  };
}

// ── 기사 크롤링 ────────────────────────────────────────

async function fetchArticle(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      timeout: 8000,
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text() ||
      $('title').text() || '';

    const content =
      $('#dic_area').text() ||
      $('#articleBodyContents').text() ||
      $('article').text() ||
      $('.article_body').text() || '';

    const images = [];
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && src.startsWith('http') && !src.includes('icon') && !src.includes('logo')) {
        images.push(src);
      }
    });

    return {
      title: title.trim().slice(0, 200),
      content: content.replace(/\s+/g, ' ').trim().slice(0, 3000),
      images: images.slice(0, 10),
    };
  } catch {
    return { title: '', content: '', images: [] };
  }
}

// ── 이미지 수집 ────────────────────────────────────────

function isValidImageUrl(src) {
  if (!src || !src.startsWith('http')) return false;
  const lower = src.toLowerCase();
  const blocked = ['icon','logo','btn','profile','emoticon','sticker','banner','/ad/','favicon','arrow','bullet','qr','naver_logo'];
  if (blocked.some(b => lower.includes(b))) return false;
  const clean = src.split('?')[0];
  return !!(
    clean.match(/\.(jpg|jpeg|png|webp|gif)$/i) ||
    src.includes('blogfiles') ||
    src.includes('postfiles') ||
    src.includes('pstatic.net') ||
    src.includes('blogimg') ||
    src.includes('mblogthumb') ||
    src.includes('imgnews') ||
    src.includes('newsimg')
  );
}

async function collectImages(keyword, articleUrl, relatedUrls = []) {
  const seen = new Set();
  const images = [];

  // 기사 URL 이미지 먼저
  if (articleUrl) {
    const article = await fetchArticle(articleUrl);
    for (const img of article.images) {
      if (isValidImageUrl(img) && !seen.has(img)) {
        seen.add(img);
        images.push(img);
      }
    }
  }

  // 키워드 변형
  const queries = [
    keyword,
    `${keyword} 근황`,
    `${keyword} 사진`,
    `${keyword} 최신`,
  ];

  const searchUrls = [];
  for (const q of queries) {
    const enc = encodeURIComponent(q);
    searchUrls.push(`https://search.naver.com/search.naver?where=news&query=${enc}`);
    searchUrls.push(`https://search.naver.com/search.naver?where=blog&query=${enc}`);
    searchUrls.push(`https://search.naver.com/search.naver?where=image&query=${enc}`);
  }

  for (const url of searchUrls) {
    if (images.length >= 150) break;
    // 관련 URL 제외
    if (relatedUrls.some(r => r && url.includes(r))) continue;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://www.naver.com/',
        },
        timeout: 5000,
      });
      const html = await res.text();
      const $ = cheerio.load(html);
      $('img').each((_, el) => {
        const src =
          $(el).attr('src') ||
          $(el).attr('data-src') ||
          $(el).attr('data-lazysrc') ||
          $(el).attr('data-original') || '';
        const cleanSrc = src.split('?')[0];
        if (isValidImageUrl(src) && !seen.has(cleanSrc)) {
          seen.add(cleanSrc);
          images.push(src);
        }
      });
    } catch { /* 계속 */ }
  }

  return images.slice(0, 150);
}

// ── 블로그 생성 ────────────────────────────────────────

async function generateBlog(keyword, articleContent, articleTitle, relatedUrls, apiKey) {
  const openai = new OpenAI({ apiKey });

  const relatedSection = relatedUrls && relatedUrls.filter(Boolean).length > 0
    ? `\n함께 읽으면 좋은 글\n\n${relatedUrls.filter(Boolean).join('\n')}`
    : '';

  const systemMessage = `너는 네이버 블로그 작가야.
반드시 유효한 JSON 1개만 출력해: {"title":"...","body":"...","hashtags":"..."}

[절대 규칙]
1. 소제목 반드시 5~7개. 없으면 실패.
2. 소제목: 순수 텍스트만. 괄호() 대괄호[] 번호(1.) "소제목" 글자 절대 금지.
3. 소제목 위 빈줄 1개, 아래 빈줄 1개 필수.
4. 각 소제목 아래 문단 4개 이상.
5. 각 문단 정확히 2문장. 3문장 이상 절대 금지.
6. 문단 사이 빈줄 1개.
7. 공백 제외 2500자 이상.
8. 한국어만. 영어 단어 금지.
9. 이모지 금지.
10. 스푼지기 한입 정리 이후 소제목 절대 금지.
11. 함께 읽으면 좋은 글 1번만 출력.`;

  const userMessage = `키워드: ${keyword}
기사 제목: ${articleTitle || '없음'}
기사 내용: ${articleContent || '없음'}

[출력 순서 - 절대 변경 금지]
1. 본문 (소제목 5~7개 포함)
2. 여러분은 어떻게 생각하셨나요?
3. 스푼지기의 한입 정리
4. 요약 2~3문장
5. 오늘도 읽어주셔서 감사합니다.
${relatedSection ? `6. 함께 읽으면 좋은 글\n\n${relatedUrls.filter(Boolean).join('\n')}` : ''}
7. 해시태그 15개

[본문 형식 예시]
첫문장이에요. 두번째문장이에요.

이 장면에서 진짜 감동받았어요

문장1이에요. 문장2에요.

문장3이에요. 문장4에요.

문장5에요. 문장6이에요.

문장7이에요. 문장8이에요.

솔직히 이건 몰랐는데 깜짝 놀랐어요

문장1이에요. 문장2에요.

문장3이에요. 문장4에요.

문장5에요. 문장6이에요.

문장7이에요. 문장8이에요.

(소제목 5~7개 이런 식으로 반복)

여러분은 어떻게 생각하셨나요?

스푼지기의 한입 정리

요약 2~3문장.

오늘도 읽어주셔서 감사합니다.

[소제목 규칙]
- 블로거가 직접 느낀 감정을 구어체로
- ~했어요 / ~더라고요 / ~않나요? 말투
- 기사 내용에 맞게 매번 새롭게 창작
- 절대 반복 금지
- 번호 금지

[제목] ${keyword} 맨 앞, 25~40자, 후킹 문장, 숫자/반전/궁금증 포함
[해시태그] 정확히 15개, 첫 태그 #${keyword}, 공백으로만 구분, 쉼표 금지

JSON만 출력.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 5000,
    temperature: 1.0,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON 형식 오류');

  const result = JSON.parse(jsonMatch[0]);
  result.body = postProcessBody(result.body);
  result.hashtags = cleanHashtags(result.hashtags, keyword);
  result.charCount = countChars(result.body);

  return result;
}

// ── API 라우트 ─────────────────────────────────────────

// 블로그 생성 시작
app.post('/blog', async (req, res) => {
  const { keyword, articleUrl, relatedUrls = [], apiKey } = req.body;
  if (!keyword || !apiKey) {
    return res.status(400).json({ error: 'keyword와 apiKey는 필수입니다.' });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  jobs.set(jobId, { status: 'pending', partialChars: 0 });
  res.json({ jobId });

  (async () => {
    try {
      const article = await fetchArticle(articleUrl || '');

      // 이미지 수집 병렬 시작
      const imagesPromise = collectImages(keyword, articleUrl, relatedUrls);

      // 블로그 생성
      const blog = await generateBlog(
        keyword,
        article.content,
        article.title,
        relatedUrls,
        apiKey
      );

      const images = await imagesPromise;

      jobs.set(jobId, {
        status: 'completed',
        ...blog,
        images,
      });
    } catch (e) {
      jobs.set(jobId, { status: 'failed', error: e.message });
    }
    setTimeout(() => jobs.delete(jobId), 3600000);
  })();
});

// 상태 조회
app.get('/blog/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

// 이미지 다운로드 프록시
app.post('/image/download', async (req, res) => {
  const { url } = req.body;
  try {
    const imgRes = await fetch(url, {
      headers: {
        'Referer': 'https://blog.naver.com/',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 8000,
    });
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
    const buffer = await imgRes.buffer();
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    res.json({
      base64: buffer.toString('base64'),
      mimeType: ct.split(';')[0].trim(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행: http://localhost:${PORT}`));
