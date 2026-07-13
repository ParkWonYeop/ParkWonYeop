import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const token = process.env.GITHUB_TOKEN;
const username = process.env.GITHUB_USERNAME;
const startYear = Number(process.env.START_YEAR ?? "2022");
const outputPath = resolve(process.env.OUTPUT_PATH ?? "dist/contribution-skyline.svg");
const currentYear = new Date().getUTCFullYear();

if (!token || !username) {
  throw new Error("GITHUB_TOKEN and GITHUB_USERNAME are required.");
}

if (!Number.isInteger(startYear) || startYear > currentYear) {
  throw new Error("START_YEAR must be a valid year no later than the current year.");
}

const query = `
  query ContributionYear($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        restrictedContributionsCount
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
            }
          }
        }
      }
    }
  }
`;

async function fetchYear(year) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = year === currentYear
    ? new Date().toISOString()
    : `${year}-12-31T23:59:59Z`;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-activity-skyline",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      query,
      variables: { login: username, from, to },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed for ${year}: ${response.status}`);
  }

  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL error for ${year}: ${payload.errors[0].message}`);
  }

  const collection = payload.data?.user?.contributionsCollection;

  if (!collection) {
    throw new Error(`No contribution data returned for ${username} in ${year}.`);
  }

  const weekly = collection.contributionCalendar.weeks.map((week) =>
    week.contributionDays.reduce((sum, day) => sum + day.contributionCount, 0),
  );

  return {
    year,
    commits: collection.totalCommitContributions,
    contributions: collection.contributionCalendar.totalContributions,
    restricted: collection.restrictedContributionsCount,
    weekly: [...weekly, ...Array(Math.max(0, 53 - weekly.length)).fill(0)].slice(0, 53),
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function compactNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function colorFor(value, maximum) {
  if (value === 0) return "#18181B";

  const ratio = value / maximum;
  if (ratio <= 0.2) return "#365314";
  if (ratio <= 0.45) return "#4D7C0F";
  if (ratio <= 0.7) return "#84CC16";
  return "#B6F13A";
}

function renderBar(x, baseline, value, maximum) {
  const width = 10;
  const depth = 3;

  if (value === 0) {
    return `<rect x="${x.toFixed(1)}" y="${baseline - 2}" width="${width}" height="2" rx="1" fill="#18181B" />`;
  }

  const height = 5 + Math.round(31 * Math.sqrt(value / maximum));
  const top = baseline - height;
  const color = colorFor(value, maximum);

  return [
    `<rect x="${x.toFixed(1)}" y="${top}" width="${width}" height="${height}" rx="1" fill="${color}" />`,
    `<path d="M${(x + width).toFixed(1)} ${top}l${depth} -${depth}v${height}l-${depth} ${depth}z" fill="#1F2E10" />`,
    `<path d="M${x.toFixed(1)} ${top}l${depth} -${depth}h${width}l-${depth} ${depth}z" fill="#D9F99D" fill-opacity="0.72" />`,
  ].join("");
}

function renderSkyline(years) {
  const width = 1200;
  const height = 610;
  const chartX = 278;
  const chartWidth = 858;
  const slot = chartWidth / 53;
  const firstBaseline = 250;
  const rowGap = 66;
  const maximum = Math.max(1, ...years.flatMap((year) => year.weekly));
  const totalCommits = years.reduce((sum, year) => sum + year.commits, 0);
  const totalContributions = years.reduce((sum, year) => sum + year.contributions, 0);
  const peak = years.reduce((best, year) =>
    year.contributions > best.contributions ? year : best,
  );

  const rows = years.map((year, rowIndex) => {
    const baseline = firstBaseline + rowIndex * rowGap;
    const bars = year.weekly.map((value, weekIndex) =>
      renderBar(chartX + weekIndex * slot, baseline, value, maximum),
    ).join("");

    return `
      <g aria-label="${year.year}: ${year.contributions} contributions">
        <text x="54" y="${baseline - 13}" class="year">${year.year}</text>
        <text x="54" y="${baseline + 10}" class="year-meta">${compactNumber(year.contributions)} CONTRIB · ${compactNumber(year.commits)} COMMITS</text>
        <line x1="${chartX}" y1="${baseline}" x2="1139" y2="${baseline}" class="track" />
        ${bars}
      </g>
    `;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(username)} multi-year contribution skyline</title>
  <desc id="description">GitHub-recognized weekly activity from ${startYear} through ${currentYear}, shown as a dark lime skyline.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#09090B" />
      <stop offset="1" stop-color="#11180D" />
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(1040 32) rotate(135) scale(470 360)" gradientUnits="userSpaceOnUse">
      <stop stop-color="#B6F13A" stop-opacity="0.12" />
      <stop offset="1" stop-color="#B6F13A" stop-opacity="0" />
    </radialGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="#FFFFFF" stroke-opacity="0.035" />
    </pattern>
    <filter id="lime-glow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="5" result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
    <style>
      text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .eyebrow { fill: #09090B; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; }
      .headline { fill: #FAFAFA; font-size: 42px; font-weight: 800; letter-spacing: -1.8px; }
      .metric-value { fill: #FAFAFA; font-size: 30px; font-weight: 800; }
      .peak-value { fill: #B6F13A; }
      .metric-label { fill: #71717A; font-size: 9px; font-weight: 700; letter-spacing: 1.2px; }
      .year { fill: #FAFAFA; font-size: 21px; font-weight: 800; }
      .year-meta { fill: #71717A; font-size: 9px; font-weight: 700; letter-spacing: 0.6px; }
      .track { stroke: #FFFFFF; stroke-opacity: 0.08; }
      .axis { fill: #52525B; font-size: 9px; letter-spacing: 1.2px; }
    </style>
  </defs>

  <rect x="1" y="1" width="1198" height="608" rx="24" fill="url(#background)" />
  <rect x="1" y="1" width="1198" height="608" rx="24" fill="url(#grid)" />
  <rect x="1" y="1" width="1198" height="608" rx="24" fill="url(#glow)" />
  <rect x="1" y="1" width="1198" height="608" rx="24" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="2" />

  <g transform="translate(52 42)">
    <rect width="176" height="28" rx="14" fill="#B6F13A" />
    <circle cx="16" cy="14" r="3.5" fill="#09090B" />
    <text x="28" y="18.5" class="eyebrow">ALL-TIME ACTIVITY</text>
  </g>

  <text x="52" y="125" class="headline">CONTRIBUTION SKYLINE</text>
  <text x="54" y="151" class="axis">GITHUB-RECOGNIZED · WEEKLY · ${startYear}—${currentYear}</text>

  <g transform="translate(674 54)">
    <g>
      <text x="0" y="31" class="metric-value">${compactNumber(totalCommits)}</text>
      <text x="0" y="51" class="metric-label">COMMITS</text>
    </g>
    <line x1="142" y1="0" x2="142" y2="65" stroke="#FFFFFF" stroke-opacity="0.1" />
    <g transform="translate(170 0)">
      <text x="0" y="31" class="metric-value">${compactNumber(totalContributions)}</text>
      <text x="0" y="51" class="metric-label">CONTRIBUTIONS</text>
    </g>
    <line x1="338" y1="0" x2="338" y2="65" stroke="#FFFFFF" stroke-opacity="0.1" />
    <g transform="translate(366 0)">
      <text x="0" y="31" class="metric-value peak-value" filter="url(#lime-glow)">${peak.year}</text>
      <text x="0" y="51" class="metric-label">PEAK YEAR · ${compactNumber(peak.contributions)}</text>
    </g>
  </g>

  <line x1="52" y1="184" x2="1148" y2="184" stroke="#FFFFFF" stroke-opacity="0.1" />
  <text x="54" y="211" class="axis">YEAR / TOTAL</text>
  <text x="278" y="211" class="axis">WEEK 01</text>
  <text x="1086" y="211" class="axis">WEEK 53</text>

  ${rows}

  <text x="54" y="583" class="axis">PUBLIC + ANONYMIZED PRIVATE CONTRIBUTIONS VISIBLE ON GITHUB</text>
  <text x="1146" y="583" text-anchor="end" class="axis">AUTO REFRESHED</text>
</svg>
`;
}

const years = await Promise.all(
  Array.from({ length: currentYear - startYear + 1 }, (_, index) => fetchYear(startYear + index)),
);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderSkyline(years), "utf8");

console.log(`Generated ${outputPath} with ${years.length} years of activity.`);
