#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const README_PATH = join(ROOT, "README.md");
const PROJECTS_PATH = join(ROOT, "data", "projects.json");
const STATS_SVG_PATH = join(ROOT, "assets", "profile-stats.svg");

const dryRun = process.argv.includes("--dry-run");
const token = process.env.GITHUB_TOKEN;

const MARKERS = {
  nowBuilding: ["profile:start:now-building", "profile:end:now-building"],
  maintenance: ["profile:start:maintenance", "profile:end:maintenance"],
};

async function githubFetch(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mxuexxmy-profile-updater",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchAllRepos(username) {
  const repos = [];
  let page = 1;

  while (true) {
    const batch = await githubFetch(
      `/users/${username}/repos?per_page=100&page=${page}&sort=pushed&type=owner`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  return repos;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatDate(isoDate) {
  return isoDate.slice(0, 10);
}

function replaceMarkerBlock(content, startMarker, endMarker, replacement) {
  const start = `<!-- ${startMarker} -->`;
  const end = `<!-- ${endMarker} -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);

  if (!pattern.test(content)) {
    throw new Error(`Missing marker block: ${startMarker}`);
  }

  return content.replace(pattern, `${start}\n${replacement.trim()}\n${end}`);
}

function extractMarkerBlock(content, startMarker, endMarker) {
  const start = `<!-- ${startMarker} -->`;
  const end = `<!-- ${endMarker} -->`;
  const pattern = new RegExp(`${start}\\n([\\s\\S]*?)\\n${end}`);
  const match = content.match(pattern);
  return match?.[1] ?? null;
}

function findRepo(repoMap, repoName) {
  return repoMap.get(repoName.toLowerCase()) ?? null;
}

function buildNowBuildingTable(featured, repoMap) {
  const rows = featured.map((item) => {
    const repo = findRepo(repoMap, item.repo);
    if (!repo) {
      throw new Error(`Featured repo not found: ${item.repo}`);
    }

    const tags = item.tags.map((tag) => `\`${tag}\``).join(" ");
    const lang = repo.language ?? "—";
    const stars = repo.stargazers_count ?? 0;
    const updated = formatDate(repo.pushed_at);
    const link = `[${repo.name}](https://github.com/${repo.full_name})`;
    const desc = `${item.description_en} / ${item.description_zh}`;

    return `| ${link} | ${tags} | ${lang} | ${stars} | ${updated} | ${desc} |`;
  });

  return [
    "| Project | Tags | Lang | Stars | Updated | Description / 简介 |",
    "| --- | --- | --- | ---: | --- | --- |",
    ...rows,
  ].join("\n");
}

function buildMaintenanceLine() {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `> Profile metrics auto-refreshed via GitHub Actions · 数据自动更新于 **${timestamp} UTC**`;
}

function computeLanguageStats(repos) {
  const counts = new Map();

  for (const repo of repos) {
    if (!repo.language) continue;
    counts.set(repo.language, (counts.get(repo.language) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}

function buildStatsSvg({ username, user, repos, topLanguages }) {
  const totalStars = repos.reduce((sum, repo) => sum + (repo.stargazers_count ?? 0), 0);
  const publicRepos = user.public_repos ?? repos.length;
  const followers = user.followers ?? 0;

  const metrics = [
    { label: "PUBLIC REPOS", value: String(publicRepos), accent: "#63e6ff", unit: "repositories" },
    { label: "TOTAL STARS", value: String(totalStars), accent: "#9b8cff", unit: "earned across repos" },
    { label: "FOLLOWERS", value: String(followers), accent: "#ffbd69", unit: "people connected" },
  ];

  const languageColors = ["#63e6ff", "#8b9dff", "#c084fc", "#5ee6a8", "#ffbd69"];
  const maxLanguageCount = topLanguages[0]?.[1] ?? 1;

  const langLines = topLanguages.length
    ? topLanguages.map(([lang, count], index) => {
        const y = 292 + index * 29;
        const width = Math.max(20, Math.round((count / maxLanguageCount) * 400));
        const color = languageColors[index % languageColors.length];
        return `
      <g>
        <text x="32" y="${y}" class="lang-name">${escapeXml(lang)}</text>
        <rect x="180" y="${y - 10}" width="400" height="8" rx="4" fill="#17213d"/>
        <rect x="180" y="${y - 10}" width="${width}" height="8" rx="4" fill="${color}" opacity="0.92"/>
        <circle cx="${180 + width}" cy="${y - 6}" r="3" fill="${color}" filter="url(#soft-glow)"/>
        <text x="660" y="${y}" class="lang-count" text-anchor="end">${count}</text>
      </g>`;
      }).join("")
    : `<text x="32" y="302" class="muted">No language data</text>`;

  const metricCards = metrics.map((metric, index) => {
    const x = 28 + index * 216;
    return `
    <g>
      <rect x="${x}" y="101" width="200" height="118" rx="16" fill="url(#card-bg)" stroke="#263657"/>
      <rect x="${x}" y="101" width="200" height="2" rx="1" fill="${metric.accent}"/>
      <circle cx="${x + 172}" cy="130" r="15" fill="${metric.accent}" opacity="0.08"/>
      <circle cx="${x + 172}" cy="130" r="4" fill="${metric.accent}" filter="url(#soft-glow)"/>
      <text x="${x + 18}" y="132" class="metric-label">${metric.label}</text>
      <text x="${x + 18}" y="177" class="metric-value">${escapeXml(metric.value)}</text>
      <text x="${x + 18}" y="201" class="metric-unit">${metric.unit}</text>
    </g>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="700" height="430" viewBox="0 0 700 430" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(username)} GitHub profile metrics</title>
  <desc id="desc">Repository, star, follower, and primary language statistics.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#070b16"/>
      <stop offset="55%" stop-color="#0b1122"/>
      <stop offset="100%" stop-color="#090d19"/>
    </linearGradient>
    <linearGradient id="card-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111a31" stop-opacity="0.96"/>
      <stop offset="100%" stop-color="#0d1428" stop-opacity="0.88"/>
    </linearGradient>
    <radialGradient id="aurora" cx="0" cy="0" r="1" gradientTransform="translate(610 10) rotate(135) scale(330 250)">
      <stop offset="0%" stop-color="#5b5fff" stop-opacity="0.26"/>
      <stop offset="45%" stop-color="#16c8d9" stop-opacity="0.09"/>
      <stop offset="100%" stop-color="#070b16" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M 28 0 L 0 0 0 28" fill="none" stroke="#7f8db3" stroke-opacity="0.055" stroke-width="1"/>
    </pattern>
    <filter id="soft-glow" x="-300%" y="-300%" width="700%" height="700%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <style>
      .eyebrow { fill: #63e6ff; font: 600 12px "SFMono-Regular", Consolas, monospace; letter-spacing: 0.7px; }
      .title { fill: #eef3ff; font: 650 25px "Segoe UI", Inter, sans-serif; letter-spacing: -0.4px; }
      .subtitle { fill: #7281a5; font: 12px "Segoe UI", Inter, sans-serif; }
      .status { fill: #8b98b7; font: 10px "SFMono-Regular", Consolas, monospace; letter-spacing: 0.8px; }
      .metric-label { fill: #8997b8; font: 600 10px "SFMono-Regular", Consolas, monospace; letter-spacing: 0.9px; }
      .metric-value { fill: #f4f7ff; font: 700 36px "SFMono-Regular", Consolas, monospace; letter-spacing: -1px; }
      .metric-unit { fill: #5f6d8e; font: 11px "Segoe UI", Inter, sans-serif; }
      .section-label { fill: #9ba8c8; font: 600 11px "SFMono-Regular", Consolas, monospace; letter-spacing: 1px; }
      .lang-name { fill: #c5cee5; font: 13px "SFMono-Regular", Consolas, monospace; }
      .lang-count { fill: #8391b2; font: 12px "SFMono-Regular", Consolas, monospace; }
      .muted { fill: #5f6d8e; font: 12px "SFMono-Regular", Consolas, monospace; }
    </style>
  </defs>
  <rect x="0.5" y="0.5" width="699" height="429" rx="20" fill="url(#bg)" stroke="#273552"/>
  <rect x="1" y="1" width="698" height="428" rx="19" fill="url(#aurora)"/>
  <rect x="1" y="1" width="698" height="428" rx="19" fill="url(#grid)"/>

  <path d="M28 87 H374 C388 87 392 91 392 105 V219" fill="none" stroke="#63e6ff" stroke-opacity="0.18"/>
  <circle cx="28" cy="87" r="2.5" fill="#63e6ff"/>
  <circle cx="392" cy="219" r="2.5" fill="#63e6ff" opacity="0.55"/>

  <text x="28" y="32" class="eyebrow">${escapeXml(username)}@github</text>
  <text x="28" y="65" class="title">Repository Telemetry</text>
  <text x="28" y="84" class="subtitle">Public signals from code, projects, and community</text>

  <circle cx="584" cy="30" r="3" fill="#5ee6a8" filter="url(#soft-glow)"/>
  <text x="595" y="34" class="status">SYNC / LIVE</text>
  <text x="672" y="54" class="status" text-anchor="end">GENERATED LOCALLY</text>

  ${metricCards}

  <text x="28" y="253" class="section-label">LANGUAGE DISTRIBUTION</text>
  <text x="672" y="253" class="status" text-anchor="end">BY REPOSITORY COUNT</text>
  <line x1="28" y1="264" x2="672" y2="264" stroke="#263657"/>
  ${langLines}
</svg>
`;
}

function writeIfChanged(path, content) {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (previous === content) return false;
  if (!dryRun) writeFileSync(path, content, "utf8");
  return true;
}

async function main() {
  const projects = JSON.parse(readFileSync(PROJECTS_PATH, "utf8"));
  const username = projects.username;

  const [user, repos] = await Promise.all([
    githubFetch(`/users/${username}`),
    fetchAllRepos(username),
  ]);

  const repoMap = new Map(repos.map((repo) => [repo.name.toLowerCase(), repo]));

  for (const item of projects.featured) {
    if (findRepo(repoMap, item.repo)) continue;
    const resolved = await githubFetch(`/repos/${username}/${item.repo}`);
    repoMap.set(resolved.name.toLowerCase(), resolved);
    repoMap.set(item.repo.toLowerCase(), resolved);
  }

  const topLanguages = computeLanguageStats(repos);

  const nowBuilding = buildNowBuildingTable(projects.featured, repoMap);
  const statsSvg = buildStatsSvg({ username, user, repos, topLanguages });

  const originalReadme = readFileSync(README_PATH, "utf8");
  const previousNowBuilding = extractMarkerBlock(
    originalReadme,
    ...MARKERS.nowBuilding
  );
  const previousStatsSvg = existsSync(STATS_SVG_PATH)
    ? readFileSync(STATS_SVG_PATH, "utf8")
    : null;

  const dataChanged =
    previousNowBuilding?.trim() !== nowBuilding.trim() ||
    previousStatsSvg !== statsSvg;

  let readme = originalReadme;
  readme = replaceMarkerBlock(readme, ...MARKERS.nowBuilding, nowBuilding);

  if (dataChanged) {
    readme = replaceMarkerBlock(readme, ...MARKERS.maintenance, buildMaintenanceLine());
  }

  const readmeChanged = writeIfChanged(README_PATH, readme);
  const svgChanged = writeIfChanged(STATS_SVG_PATH, statsSvg);

  console.log(`README changed: ${readmeChanged}`);
  console.log(`Stats SVG changed: ${svgChanged}`);
  console.log(`Dry run: ${dryRun}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
