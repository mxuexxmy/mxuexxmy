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

function buildNowBuildingTable(featured, repoMap) {
  const rows = featured.map((item) => {
    const repo = repoMap.get(item.repo);
    if (!repo) {
      throw new Error(`Featured repo not found: ${item.repo}`);
    }

    const tags = item.tags.map((tag) => `\`${tag}\``).join(" ");
    const lang = repo.language ?? "—";
    const stars = repo.stargazers_count ?? 0;
    const updated = formatDate(repo.pushed_at);
    const link = `[${item.repo}](https://github.com/${repo.full_name.split("/")[0]}/${item.repo})`;
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
    { label: "Public Repos", value: String(publicRepos) },
    { label: "Total Stars", value: String(totalStars) },
    { label: "Followers", value: String(followers) },
  ];

  const langLines = topLanguages.length
    ? topLanguages.map(([lang, count], index) => {
        const y = 188 + index * 22;
        const width = Math.max(24, Math.round((count / topLanguages[0][1]) * 180));
        return `
          <text x="24" y="${y}" fill="#a9b1d6" font-size="12" font-family="Consolas, monospace">${escapeXml(lang)}</text>
          <rect x="120" y="${y - 12}" width="${width}" height="10" rx="3" fill="#7aa2f7" opacity="0.85"/>
          <text x="310" y="${y}" fill="#565f89" font-size="11" font-family="Consolas, monospace" text-anchor="end">${count}</text>`;
      }).join("")
    : `<text x="24" y="200" fill="#565f89" font-size="12" font-family="Consolas, monospace">No language data</text>`;

  const metricCards = metrics.map((metric, index) => {
    const x = 24 + index * 158;
    return `
      <rect x="${x}" y="72" width="146" height="72" rx="10" fill="#24283b" stroke="#414868"/>
      <text x="${x + 16}" y="98" fill="#565f89" font-size="11" font-family="Segoe UI, sans-serif">${metric.label}</text>
      <text x="${x + 16}" y="126" fill="#c0caf5" font-size="24" font-weight="700" font-family="Consolas, monospace">${escapeXml(metric.value)}</text>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="495" height="280" viewBox="0 0 495 280">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a1b27"/>
      <stop offset="100%" stop-color="#16161e"/>
    </linearGradient>
  </defs>
  <rect width="495" height="280" rx="12" fill="url(#bg)" stroke="#414868"/>
  <text x="24" y="34" fill="#7aa2f7" font-size="13" font-family="Consolas, monospace">mxuexxmy@github</text>
  <text x="24" y="54" fill="#c0caf5" font-size="18" font-weight="700" font-family="Segoe UI, sans-serif">Profile Metrics</text>
  ${metricCards}
  <text x="24" y="168" fill="#9ece6a" font-size="12" font-family="Consolas, monospace">top languages by repo count</text>
  ${langLines}
  <text x="471" y="268" fill="#565f89" font-size="10" font-family="Consolas, monospace" text-anchor="end">generated locally</text>
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

  const repoMap = new Map(repos.map((repo) => [repo.name, repo]));
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
