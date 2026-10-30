import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

// All production graphics are editable vectors. No external service or font CDN.
const BRAND = "agent-knowledge-hub";
const root = path.resolve("brand-kit"),
  publicRoot = path.resolve("public/brand");
const glyphs = JSON.parse(
  await fs.readFile(
    new URL("./brand-wordmark-glyphs.json", import.meta.url),
    "utf8",
  ),
);
const icons = JSON.parse(
  await fs.readFile(
    new URL("../src/ui/brand-icons.json", import.meta.url),
    "utf8",
  ),
);
const markPaths = JSON.parse(
  await fs.readFile(new URL("../src/ui/brand-mark.json", import.meta.url), "utf8"),
);
await fs.mkdir(path.join(root, "icons"), { recursive: true });
await fs.mkdir(path.join(publicRoot, "icons"), { recursive: true });
const palette = {
  light: {
    bg: "#f8f9fc",
    surface: "#ffffff",
    ink: "#222636",
    muted: "#657087",
    accent: "#78469e",
    strong: "#623680",
    soft: "#eee6f5",
    line: "#e0e4ee",
  },
  dark: {
    bg: "#0d1018",
    surface: "#171b26",
    ink: "#edf0f8",
    muted: "#a5aec0",
    accent: "#d4a1eb",
    strong: "#eac7f6",
    soft: "#352a43",
    line: "#2c3445",
  },
};
const svg = (w, h, body, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${BRAND} ${label}"><title>${BRAND} · ${label}</title>${body}</svg>`;
const rect = (x, y, w, h, fill, radius = 0, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" ${extra}/>`;
const text = (value, x, y, size, fill, extra = "") =>
  `<text x="${x}" y="${y}" font-family="DejaVu Sans,Arial,sans-serif" font-size="${size}" fill="${fill}" ${extra}>${value}</text>`;
// Original Folio Wiki symbol, retained unchanged by the user's brand decision.
// The two path definitions, stroke widths and joins match the original source.
function originalSymbol(primary, secondary = primary) {
  return `<path class="primary-stroke" d="${markPaths.outerPath}" fill="none" stroke="${primary}" stroke-width="${markPaths.outerStrokeWidth}" stroke-linejoin="round"/><path class="secondary-stroke" d="${markPaths.innerPath}" fill="none" stroke="${secondary}" stroke-width="${markPaths.innerStrokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`;
}
const symbol = (primary, secondary = primary) =>
  `<g transform="scale(1.28)">${originalSymbol(primary, secondary)}</g>`;
const placeSymbol = (x, y, size, p, s) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 128 128">${symbol(p, s)}</svg>`;
const mark = (p, s, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100" role="img" aria-label="${BRAND} hexagon book symbol"><title>${BRAND}</title>${bg ? rect(0, 0, 100, 100, bg, 22) : ""}${originalSymbol(p, s)}</svg>`;
function wordPaths(x, baseline, size, color) {
  const scale = size / glyphs.unitsPerEm;
  let cursor = 0;
  const paths = [];
  for (const char of BRAND) {
    const glyph = glyphs.glyphs[char];
    paths.push(`<path transform="translate(${cursor} 0)" d="${glyph.path}"/>`);
    cursor += glyph.advance;
  }
  return `<g aria-label="${BRAND}" fill="${color}" transform="translate(${x} ${baseline}) scale(${scale} ${-scale})">${paths.join("")}</g>`;
}
const iconBody = (name) =>
  `<path d="${icons[name]}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
const iconAt = (name, x, y, size, color) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" color="${color}">${iconBody(name)}</svg>`;
async function pair(name, source) {
  await fs.writeFile(path.join(root, `${name}.svg`), source + "\n");
  await sharp(Buffer.from(source))
    .png()
    .toFile(path.join(root, `${name}.png`));
}
for (const [name, p, s, bg] of [
  ["light", palette.light.accent, palette.light.strong],
  ["dark", palette.dark.accent, palette.dark.strong],
  ["mono-black", "#222222", "#222222"],
  ["mono-white", "#ffffff", "#ffffff"],
  ["tile-light", palette.light.accent, palette.light.strong, "#f3edf8"],
  ["tile-dark", palette.dark.accent, palette.dark.strong, "#211e26"],
])
  await pair(`mark-${name}`, mark(p, s, bg));

const favicon = svg(
  128,
  128,
  `<style>@media(prefers-color-scheme:dark){.primary-stroke{stroke:#d4a1eb}.secondary-stroke{stroke:#eac7f6}}</style>${symbol(palette.light.accent, palette.light.strong)}`,
  "adaptive favicon",
);
await fs.writeFile(path.join(root, "favicon.svg"), favicon + "\n");
for (const size of [16, 24, 32, 48, 64, 128, 180, 192, 256, 512]) {
  await sharp(Buffer.from(mark(palette.light.accent, palette.light.strong)))
    .resize(size)
    .png()
    .toFile(path.join(root, `favicon-${size}.png`));
}
const icoSizes = [16, 32, 48];
const images = await Promise.all(
  icoSizes.map((size) => fs.readFile(path.join(root, `favicon-${size}.png`))),
);
const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
for (let i = 0; i < images.length; i++) {
  const pos = 6 + i * 16;
  directory[pos] = icoSizes[i];
  directory[pos + 1] = icoSizes[i];
  directory.writeUInt16LE(1, pos + 4);
  directory.writeUInt16LE(32, pos + 6);
  directory.writeUInt32LE(images[i].length, pos + 8);
  directory.writeUInt32LE(offset, pos + 12);
  offset += images[i].length;
}
await fs.writeFile(
  path.join(root, "favicon.ico"),
  Buffer.concat([directory, ...images]),
);

function pattern(p, x, y, factor = 1) {
  const card = (cx, cy, w, h) =>
    rect(cx, cy, w, h, p.surface, 12, `stroke="${p.line}" stroke-width="2"`) +
    `<path d="M${cx + 18} ${cy + 24}h${w - 46}m${46 - w} 15h${w - 36}" stroke="${p.accent}" stroke-width="3" stroke-linecap="round" opacity=".5"/>`;
  return `<g transform="translate(${x} ${y}) scale(${factor})"><path d="M80 55h64v95h55M80 245h64v-95M245 150h85" fill="none" stroke="${p.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".65"/>${card(0, 18, 102, 76)}${card(0, 208, 102, 76)}${rect(185, 102, 96, 96, p.soft, 24, `stroke="${p.accent}" stroke-width="2"`)}${placeSymbol(198, 115, 70, p.accent, p.strong)}${card(330, 112, 104, 76)}<circle cx="144" cy="150" r="5" fill="${p.accent}"/></g>`;
}
for (const mode of ["light", "dark"]) {
  const p = palette[mode];
  await pair(
    `wordmark-${mode}`,
    svg(
      1120,
      180,
      placeSymbol(20, 26, 128, p.accent, p.strong) +
        wordPaths(176, 112, 64, p.ink),
      `${mode} outlined wordmark`,
    ),
  );
  await pair(
    `readme-banner-${mode}`,
    svg(
      1600,
      480,
      rect(0, 0, 1600, 480, p.bg) +
        rect(1040, 0, 560, 480, p.surface) +
        text("AGENT KNOWLEDGE HUB", 76, 66, 13, p.muted, 'letter-spacing="3"') +
        placeSymbol(65, 124, 100, p.accent, p.strong) +
        wordPaths(182, 190, 62, p.ink) +
        text("Knowledge that compounds.", 78, 278, 32, p.ink) +
        text(
          "Connected sources. Living knowledge. Reusable outcomes.",
          78,
          320,
          18,
          p.muted,
        ) +
        ["SOURCE", "WIKI", "REUSE"]
          .map(
            (s, i) =>
              rect(78 + i * 154, 373, 136, 37, p.soft, 7) +
              text(s, 98 + i * 154, 397, 12, p.accent, 'letter-spacing="2"'),
          )
          .join("") +
        pattern(p, 1100, 88, 0.98),
      `${mode} repository banner`,
    ),
  );
  await pair(
    `open-graph-${mode}`,
    svg(
      1200,
      630,
      rect(0, 0, 1200, 630, p.bg) +
        rect(820, 0, 380, 630, p.surface) +
        text("AGENT KNOWLEDGE HUB", 64, 64, 14, p.muted, 'letter-spacing="3"') +
        placeSymbol(54, 118, 112, p.accent, p.strong) +
        wordPaths(182, 190, 52, p.ink) +
        text("Knowledge that", 68, 330, 58, p.ink, 'font-weight="600"') +
        text("compounds.", 68, 406, 58, p.accent, 'font-weight="600"') +
        text("Sources → wiki → reusable outcomes", 70, 477, 20, p.muted) +
        pattern(p, 846, 222, 0.72) +
        text(
          "INGEST / QUERY / LINT",
          70,
          568,
          13,
          p.muted,
          'letter-spacing="2"',
        ),
      `${mode} social card`,
    ),
  );
  await pair(
    `social-avatar-${mode}`,
    svg(
      512,
      512,
      rect(0, 0, 512, 512, p.bg, 112) +
        placeSymbol(68, 68, 376, p.accent, p.strong),
      `${mode} avatar`,
    ),
  );
  await pair(
    `empty-state-${mode}`,
    svg(
      480,
      320,
      rect(0, 0, 480, 320, p.bg, 20) +
        `<path d="M140 174h60m80 0h60M240 93v45" fill="none" stroke="${p.line}" stroke-width="3" stroke-dasharray="5 7"/>` +
        rect(191, 123, 98, 98, p.soft, 22) +
        placeSymbol(204, 136, 72, p.accent, p.strong) +
        rect(
          108,
          148,
          42,
          52,
          p.surface,
          7,
          `stroke="${p.line}" stroke-width="2"`,
        ) +
        rect(
          330,
          148,
          42,
          52,
          p.surface,
          7,
          `stroke="${p.line}" stroke-width="2"`,
        ) +
        rect(
          219,
          50,
          42,
          52,
          p.surface,
          7,
          `stroke="${p.line}" stroke-width="2"`,
        ),
      `${mode} empty knowledge state`,
    ),
  );
}
let symbols = "";
for (const name of Object.keys(icons)) {
  await fs.writeFile(
    path.join(root, `icons/${name}.svg`),
    svg(24, 24, iconBody(name), `${name} icon`) + "\n",
  );
  symbols += `<symbol id="${name}" viewBox="0 0 24 24">${iconBody(name)}</symbol>`;
}
await fs.writeFile(
  path.join(root, "icons/sprite.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg">${symbols}</svg>\n`,
);
const l = palette.light,
  d = palette.dark;
await pair(
  "brand-preview",
  svg(
    1600,
    1260,
    rect(0, 0, 1600, 1260, l.bg) +
      text(
        "AGENT KNOWLEDGE HUB / IDENTITY 01",
        64,
        57,
        14,
        l.muted,
        'letter-spacing="2"',
      ) +
      rect(64, 88, 1472, 220, d.bg, 20) +
      placeSymbol(95, 129, 128, d.accent, d.strong) +
      wordPaths(250, 192, 65, d.ink) +
      text("Knowledge that compounds.", 254, 246, 22, d.muted) +
      rect(64, 338, 472, 290, l.soft, 18) +
      rect(558, 338, 472, 290, d.surface, 18) +
      rect(1052, 338, 484, 290, "#ffffff", 18, `stroke="${l.line}"`) +
      placeSymbol(190, 373, 220, l.accent, l.strong) +
      placeSymbol(684, 373, 220, d.accent, d.strong) +
      placeSymbol(1123, 402, 150, l.ink, l.ink) +
      placeSymbol(1303, 416, 100, l.ink, l.ink) +
      text("LIGHT", 88, 603, 11, l.strong, 'letter-spacing="2"') +
      text("DARK", 582, 603, 11, d.accent, 'letter-spacing="2"') +
      text("MONO / SMALL SIZES", 1076, 603, 11, l.muted, 'letter-spacing="2"') +
      text("24 WORKSPACE ICONS", 66, 685, 13, l.muted, 'letter-spacing="2"') +
      Object.keys(icons)
        .map((name, i) => {
          const x = 64 + (i % 12) * 124,
            y = 718 + Math.floor(i / 12) * 102;
          return (
            rect(x, y, 108, 84, l.surface, 10, `stroke="${l.line}"`) +
            iconAt(name, x + 40, y + 12, 28, l.accent) +
            text(name, x + 54, y + 65, 11, l.muted, 'text-anchor="middle"')
          );
        })
        .join("") +
      text("GRAPHITE &amp; PLUM", 66, 970, 13, l.muted, 'letter-spacing="2"') +
      [l.accent, l.strong, d.accent, d.strong, d.bg, d.surface]
        .map(
          (c, i) =>
            rect(64 + i * 151, 993, 132, 66, c, 8) +
            text(c, 64 + i * 151, 1084, 12, l.muted),
        )
        .join("") +
      rect(1012, 987, 524, 102, l.surface, 12, `stroke="${l.line}"`) +
      [16, 24, 32, 48, 64]
        .map((size, i) =>
          placeSymbol(
            1044 + i * 86,
            1006 + (64 - size) / 2,
            size,
            l.accent,
            l.strong,
          ),
        )
        .join("") +
      text(
        "SVG + PNG / OUTLINED WORDMARK / FAVICON / BANNERS / SOCIAL / UI",
        66,
        1164,
        13,
        l.muted,
        'letter-spacing="1"',
      ) +
      text(
        "One identity. Editable sources. Built for the same workspace.",
        66,
        1203,
        18,
        l.ink,
      ),
    "complete brand asset preview",
  ),
);

await fs.writeFile(
  path.join(root, "site.webmanifest"),
  JSON.stringify(
    {
      name: BRAND,
      short_name: "AKH",
      description: "Connected, evidence-backed knowledge maintained by agents.",
      start_url: "/",
      scope: "/",
      icons: [192, 512].map((size) => ({
        src: `/brand/favicon-${size}.png`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose: "any",
      })),
      theme_color: d.bg,
      background_color: d.bg,
      display: "standalone",
    },
    null,
    2,
  ) + "\n",
);
await fs.writeFile(
  path.join(root, "README.md"),
  `# ${BRAND} 브랜드 에셋

브랜드 표기는 **agent-knowledge-hub**다. 심볼은 최초 Folio Wiki에서 사용한 **육각형 안의 펼친 책**을 그대로 사용한다. 사용자가 이 기존 심볼을 선택했으며, 원본의 두 path·선 두께·비율·plum 색상과 단색·타일 변형을 보존한다. 워드마크와 배너의 제품 이름은 agent-knowledge-hub으로 유지한다. Gate와의 경험 일관성을 위해 Graphite & Plum 색상을 사용한다.

| 파일 | 용도 |
| --- | --- |
| mark-light / mark-dark | 투명 배경 심볼. 밝은 / 어두운 배경에 사용 |
| mark-mono-black / mark-mono-white | 단색 인쇄·각인 |
| mark-tile-light / mark-tile-dark | 배경이 있는 앱 타일 |
| wordmark-light / wordmark-dark | 전체 이름을 SVG path로 고정한 가로형 워드마크 |
| favicon.svg / favicon-*.png / favicon.ico | 테마 대응 SVG, 16–512px PNG, 16/32/48px ICO |
| readme-banner-light / readme-banner-dark | 1600×480 저장소·문서 배너 |
| open-graph-light / open-graph-dark | 1200×630 소셜 카드 |
| social-avatar-light / social-avatar-dark | 512×512 프로필 이미지 |
| empty-state-light / empty-state-dark | 480×320 빈 지식 공간 일러스트 |
| icons/ | 새로 그린 ${Object.keys(icons).length}개 UI 아이콘과 SVG sprite |
| brand-preview | 전체 세트 미리보기 |
| asset-manifest.json | 파일별 크기·SHA-256·브랜드 정보 |

심볼 최소 크기는 16px, 기본 앱 크기는 32px다. 주변에 폭의 15% 이상 여백을 둔다. 이름의 하이픈·소문자를 유지한다. 좁은 사이드바에서는 agent- / knowledge-hub 두 줄로 배치한다. 그림자·그라데이션·새 색을 임의로 추가하지 않는다.

아이콘은 24×24 기준, 1.8 stroke, currentColor다. 공통 원본은 src/ui/brand-icons.json이며 앱의 BrandIcon과 에셋 생성기가 함께 사용한다. 일반 유틸리티용 Lucide는 별도 라이선스를 따른다.

워드마크는 DejaVu Sans의 필요한 글자 윤곽만 사용해 폰트 설치나 CDN이 필요 없다. 출처·라이선스는 third-party-licenses/dejavu-font-license.txt에 보존한다. 보조 문구는 SVG text이며 PNG 사본을 제공한다. webmanifest는 메타데이터이며 오프라인 PWA나 서비스워커를 구현한 것은 아니다.

웹 앱의 로고는 같은 두 path를 `src/ui/brand-mark.json`에서 읽는 `BrandMark` 컴포넌트로 표시한다. 색은 `--brand-mark-primary`/`--brand-mark-secondary`가 활성 CSS `--color-accent`/`--color-accent-strong`을 따라가므로 테마 또는 팔레트 변경 시 PNG/SVG를 다시 만들 필요가 없다. 브라우저 favicon은 활성 CSS 토큰으로 갱신되며, 이 폴더의 SVG/PNG/ICO는 배포·인쇄·소셜 공유를 위한 고정 Plum 원본이다. 정적 에셋의 색상까지 바꿀 경우에만 생성기를 실행한다.

프로젝트 루트에서 npm ci 후 npm run brand로 다시 생성한다. Node.js와 프로젝트의 sharp만 사용한다. 심볼·배치·색상은 scripts/generate-brand.mjs, 워드마크 윤곽은 scripts/brand-wordmark-glyphs.json, UI 아이콘은 src/ui/brand-icons.json을 편집한다. 외부 서비스·웹폰트는 호출하지 않는다.

별도 중첩 ZIP 없이 이 폴더 전체를 에셋 팩으로 사용한다. 프로젝트 전용 심볼·아이콘·일러스트와 폰트 윤곽의 라이선스 범위를 구분해 유지한다.
`,
);
for (const [source, dest] of [
  ["mark-light.svg", "mark.svg"],
  ["mark-dark.svg", "mark-dark.svg"],
  ["favicon.svg", "favicon.svg"],
  ["favicon.ico", "favicon.ico"],
  ["favicon-180.png", "apple-touch-icon.png"],
  ["favicon-192.png", "favicon-192.png"],
  ["favicon-512.png", "favicon-512.png"],
  ["site.webmanifest", "site.webmanifest"],
  ["open-graph-dark.png", "open-graph-dark.png"],
  ["empty-state-light.svg", "empty-state-light.svg"],
  ["empty-state-dark.svg", "empty-state-dark.svg"],
  ["icons/sprite.svg", "icons/sprite.svg"],
])
  await fs.copyFile(path.join(root, source), path.join(publicRoot, dest));
const files = [];
async function inventory(dir) {
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await inventory(file);
    else if (entry.name !== "asset-manifest.json") {
      const content = await fs.readFile(file);
      files.push({
        path: path.relative(root, file).split(path.sep).join("/"),
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
}
await inventory(root);
await fs.writeFile(
  path.join(root, "asset-manifest.json"),
  JSON.stringify(
    {
      brand: BRAND,
      identity_version: "1.1.0",
      symbol: "Hexagon Book (original Folio Wiki symbol)",
      icon_count: Object.keys(icons).length,
      palette,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `${BRAND}: ${files.length + 1} brand files, ${Object.keys(icons).length} icons, app copies generated.`,
);
