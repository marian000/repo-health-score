import type { Grade, Report } from '../scoring/engine.js';

/**
 * Grade colours, following the convention shields.io users already read
 * intuitively: green is fine, red needs attention.
 */
const GRADE_COLORS: Record<Grade, string> = {
  A: '#4c1',
  B: '#97ca00',
  C: '#dfb317',
  D: '#fe7d37',
  E: '#e05d44',
  F: '#e05d44',
};

const LABEL = 'repo health';
const LABEL_BACKGROUND = '#555';

/** Verdana 11px, rendered at 110% scale as shields.io does. */
const CHAR_WIDTH = 6.6;
const PADDING = 10;
const HEIGHT = 20;

/**
 * Render a self-contained static badge.
 *
 * Static, not served from an endpoint: the MVP ships no backend, and a badge
 * committed to the repo is what lets the project display its own score without
 * one. The dynamic badge is deliberately deferred to v1.
 */
export function renderBadge(report: Report): string {
  const message = `${report.grade} (${String(report.score)}/100)`;
  const color = GRADE_COLORS[report.grade];

  const labelWidth = textWidth(LABEL) + PADDING * 2;
  const messageWidth = textWidth(message) + PADDING * 2;
  const totalWidth = labelWidth + messageWidth;

  // Text is centred in its half, at 10x scale to match the transform below.
  const labelCenter = (labelWidth / 2) * 10;
  const messageCenter = (labelWidth + messageWidth / 2) * 10;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${round(totalWidth)}" height="${HEIGHT}" role="img" aria-label="${escapeXml(LABEL)}: ${escapeXml(message)}">
  <title>${escapeXml(LABEL)}: ${escapeXml(message)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${round(totalWidth)}" height="${HEIGHT}" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${round(labelWidth)}" height="${HEIGHT}" fill="${LABEL_BACKGROUND}"/>
    <rect x="${round(labelWidth)}" width="${round(messageWidth)}" height="${HEIGHT}" fill="${color}"/>
    <rect width="${round(totalWidth)}" height="${HEIGHT}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${round(labelCenter)}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${round(textWidth(LABEL) * 10)}">${escapeXml(LABEL)}</text>
    <text x="${round(labelCenter)}" y="140" transform="scale(.1)" textLength="${round(textWidth(LABEL) * 10)}">${escapeXml(LABEL)}</text>
    <text aria-hidden="true" x="${round(messageCenter)}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${round(textWidth(message) * 10)}">${escapeXml(message)}</text>
    <text x="${round(messageCenter)}" y="140" transform="scale(.1)" textLength="${round(textWidth(message) * 10)}">${escapeXml(message)}</text>
  </g>
</svg>
`;
}

/**
 * Approximate rendered width. `textLength` on each `<text>` forces the glyphs
 * to fit whatever we compute, so a small error shifts kerning rather than
 * overflowing the badge.
 */
function textWidth(text: string): number {
  return text.length * CHAR_WIDTH;
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * The message is built from a score and a grade, so it cannot currently carry
 * markup. Escaping anyway costs nothing and keeps the function safe if a future
 * caller renders a repo or branch name into the badge.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
