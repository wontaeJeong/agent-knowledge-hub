import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  sharp = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + "/sharp");
}
const root = path.resolve("brand-kit");
await fs.mkdir(root, { recursive: true });
const mark = (color = "#78469e", secondary = "#623680", bg = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100" role="img" aria-label="Folio Wiki mark"><title>Folio Wiki</title>${bg ? `<rect width="100" height="100" rx="22" fill="${bg}"/>` : ""}<path d="M50 15 87 28v49L50 91 13 77V28z" fill="none" stroke="${color}" stroke-width="8" stroke-linejoin="round"/><path d="M50 37v40M27 36l14 5v24l-14-5M73 36l-14 5v24l14-5" fill="none" stroke="${secondary}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
for (const [name, c, s, b] of [
  ["light", "#78469e", "#623680", ""],
  ["dark", "#d4a1eb", "#eac7f6", ""],
  ["mono-black", "#222222", "#222222", ""],
  ["mono-white", "#ffffff", "#ffffff", ""],
  ["tile-light", "#78469e", "#623680", "#f3edf8"],
  ["tile-dark", "#d4a1eb", "#eac7f6", "#211e26"],
]) {
  const svg = mark(c, s, b);
  await fs.writeFile(`${root}/mark-${name}.svg`, svg);
  await sharp(Buffer.from(svg))
    .resize(512)
    .png()
    .toFile(`${root}/mark-${name}.png`);
}
await fs.copyFile(`${root}/mark-dark.svg`, "public/brand/mark-dark.svg");
await fs.copyFile(`${root}/mark-light.svg`, "public/brand/mark.svg");
await fs.copyFile(`${root}/mark-light.svg`, "public/brand/favicon.svg");
for (const size of [16, 24, 32, 48, 64, 128, 180, 192, 256, 512]) {
  await sharp(Buffer.from(mark()))
    .resize(size)
    .png()
    .toFile(`${root}/favicon-${size}.png`);
}
const png = await fs.readFile(`${root}/favicon-32.png`);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 32;
ico[7] = 32;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await fs.writeFile(`${root}/favicon.ico`, Buffer.concat([ico, png]));
for (const mode of ["light", "dark"]) {
  const bg = mode === "light" ? "#fbfafc" : "#19171d";
  const fg = mode === "light" ? "#292631" : "#eeeaf2";
  const accent = mode === "light" ? "#78469e" : "#d4a1eb";
  const inner = mark(accent, accent).replace(
    /<svg[^>]*>/,
    '<svg x="52" y="47" width="88" height="88" viewBox="0 0 100 100">',
  );
  const word = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="180" viewBox="0 0 720 180"><rect width="720" height="180" fill="${bg}"/>${inner}<text x="165" y="114" font-family="Arial,sans-serif" font-size="67" font-weight="600" fill="${fg}">folio<tspan font-weight="300" fill="${accent}"> wiki</tspan></text></svg>`;
  await fs.writeFile(`${root}/wordmark-${mode}.svg`, word);
  await sharp(Buffer.from(word)).png().toFile(`${root}/wordmark-${mode}.png`);
  const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="480" viewBox="0 0 1600 480"><rect width="1600" height="480" fill="${bg}"/><path d="M1080 0v480M1220 0v480M1360 0v480M1500 0v480M980 100h620M980 240h620M980 380h620" fill="none" stroke="${accent}" opacity=".08"/>${mark(accent, accent).replace(/<svg[^>]*>/, '<svg x="100" y="145" width="126" height="126" viewBox="0 0 100 100">')}<text x="260" y="235" font-family="Arial,sans-serif" font-size="82" font-weight="600" fill="${fg}">folio wiki</text><text x="265" y="284" font-family="Arial,sans-serif" font-size="23" fill="${accent}">Knowledge, connected.</text><rect x="1160" y="170" width="236" height="140" rx="12" fill="${bg}" stroke="${accent}" opacity=".5"/><path d="M1190 205h100m-100 25h170m-170 25h150m-150 25h120" stroke="${accent}" stroke-width="3" opacity=".45" stroke-linecap="round"/></svg>`;
  await fs.writeFile(`${root}/readme-banner-${mode}.svg`, banner);
  await sharp(Buffer.from(banner))
    .png()
    .toFile(`${root}/readme-banner-${mode}.png`);
  await sharp(Buffer.from(mark(accent, accent, bg)))
    .resize(512)
    .png()
    .toFile(`${root}/social-avatar-${mode}.png`);
  await sharp(Buffer.from(banner))
    .resize(1200, 630, { fit: "contain", background: bg })
    .png()
    .toFile(`${root}/open-graph-${mode}.png`);
}
const icons = {
  book: "M12 6C8 3 5 3 2 4v15c3-1 6-1 10 2m0-15c4-3 7-3 10-2v15c-3-1-6-1-10 2V6",
  page: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5",
  source: "M8 7H4v14h13v-4M8 3h12v14H8zM11 7h6M11 11h4",
  inbox: "M4 4h16l2 12v5H2v-5zM2 16h6l2 3h4l2-3h6",
  branch: "M6 3v12a5 5 0 0 0 5 5h6M6 9h8a4 4 0 0 0 4-4V3",
  manager: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 7v5l4 2",
  history: "M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v6l3 2",
  lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4M12 14v3",
  check: "m5 12 4 4L19 6",
  share:
    "M8 12 17 5M8 12l9 7M7 12a2 2 0 1 0-4 0 2 2 0 0 0 4 0M21 4a2 2 0 1 0-4 0 2 2 0 0 0 4 0M21 20a2 2 0 1 0-4 0 2 2 0 0 0 4 0",
  search: "M17 10a7 7 0 1 0-14 0 7 7 0 0 0 14 0m-2 5 6 6",
  roadmap: "M4 3h16v5H4zM4 16h16v5H4zM12 8v8",
  activity: "M2 12h5l3-8 4 16 3-8h5",
};
await fs.mkdir(`${root}/icons`, { recursive: true });
let symbols = "";
for (const [name, d] of Object.entries(icons)) {
  const body = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`;
  await fs.writeFile(
    `${root}/icons/${name}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="${name}">${body}</svg>`,
  );
  symbols += `<symbol id="${name}" viewBox="0 0 24 24">${body}</symbol>`;
}
await fs.writeFile(
  `${root}/icons/sprite.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg">${symbols}</svg>`,
);
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960" viewBox="0 0 1440 960"><rect width="1440" height="960" fill="#fbfafc"/><text x="72" y="83" font-family="Arial" font-size="15" fill="#75717f" letter-spacing="3">FOLIO WIKI / BRAND ASSETS 01</text><rect x="72" y="127" width="628" height="370" rx="14" fill="#f3edf8"/><rect x="720" y="127" width="648" height="370" rx="14" fill="#211e26"/>${mark().replace(/<svg[^>]*>/, '<svg x="260" y="195" width="215" height="215" viewBox="0 0 100 100">')}${mark("#d4a1eb", "#eac7f6").replace(/<svg[^>]*>/, '<svg x="930" y="195" width="215" height="215" viewBox="0 0 100 100">')}<text x="72" y="577" font-family="Arial" font-size="55" font-weight="600" fill="#292631">folio<tspan font-weight="300" fill="#78469e"> wiki</tspan></text><text x="75" y="623" font-family="Arial" font-size="16" fill="#75717f">Editable vectors. Light + dark. Built for the same workspace.</text><text x="74" y="710" font-family="Arial" font-size="12" fill="#75717f" letter-spacing="2">PLUM PALETTE</text>${["#78469e", "#623680", "#d4a1eb", "#eac7f6"].map((c, i) => `<rect x="${72 + i * 158}" y="740" width="138" height="65" rx="7" fill="${c}"/><text x="${72 + i * 158}" y="832" font-family="Arial" font-size="13" fill="#75717f">${c}</text>`).join("")}<text x="800" y="710" font-family="Arial" font-size="12" fill="#75717f" letter-spacing="2">14 WORKSPACE ICONS</text>${Object.entries(
  icons,
)
  .map(
    ([n, d], i) =>
      `<svg x="${802 + (i % 7) * 75}" y="${747 + Math.floor(i / 7) * 65}" width="28" height="28" viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="#78469e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  )
  .join(
    "",
  )}<text x="72" y="918" font-family="Arial" font-size="12" fill="#75717f">FAVICON / WORDMARK / README BANNER / SOCIAL / UI ICONS</text></svg>`;
await fs.writeFile(`${root}/brand-preview.svg`, preview);
await sharp(Buffer.from(preview)).png().toFile(`${root}/brand-preview.png`);
await fs.writeFile(
  `${root}/site.webmanifest`,
  JSON.stringify(
    {
      name: "Folio Wiki",
      short_name: "Folio",
      icons: [
        { src: "favicon-192.png", sizes: "192x192", type: "image/png" },
        { src: "favicon-512.png", sizes: "512x512", type: "image/png" },
      ],
      theme_color: "#78469e",
      background_color: "#fbfafc",
      display: "standalone",
    },
    null,
    2,
  ),
);
await fs.writeFile(
  `${root}/README.md`,
  "# Folio Wiki 아이콘 팩\n\n편집 가능한 SVG 원본과 PNG, favicon ICO, 워드마크, README 배너, 소셜 이미지, 14개 UI 아이콘과 스프라이트를 제공합니다. 기존 agent-admission-gate의 plum 색상 4개를 유지하고 책과 연결 구조를 새 심볼로 구성했습니다. 기존 Gate 로고 파일 자체를 복제하지 않았습니다.\n\n가이드: 심볼 주변 최소 15% 여백, 16px 이하에서는 favicon 사용, 라이트 및 다크 전용 변형 선택. 워드마크는 시스템 Arial 텍스트 기반이므로 배포 환경의 폰트에 따라 SVG 텍스트 모양이 달라질 수 있습니다. 동일 결과가 필요하면 PNG를 사용하거나 사내 디자인 도구에서 텍스트를 아웃라인 처리하세요. 웹폰트는 포함하지 않습니다. site.webmanifest는 자산 예시이며 서비스워커나 오프라인 PWA를 구현한 것은 아닙니다.\n\n이 폴더의 새 벡터와 생성 PNG는 프로젝트 전용 창작 자산입니다. 사내에서 수정·사용할 수 있습니다. 생성은 scripts/generate-brand.mjs로 재현합니다. 앱의 Lucide 아이콘은 별도 ISC 라이선스를 따릅니다.\n",
);
console.log("brand assets generated");
