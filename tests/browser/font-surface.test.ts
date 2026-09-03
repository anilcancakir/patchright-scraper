import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Dockerfile is the source of truth for what actually ships. Reading it
// from disk (rather than restating a list in TypeScript) is what makes this
// test detect drift instead of merely documenting intent.
const DOCKERFILE_PATH = fileURLToPath(new URL('../../Dockerfile', import.meta.url));
const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');

// The four packages this step installs, closing the measured 5-of-20 gap.
const FONT_PACKAGES = [
  'fonts-dejavu-core',
  'fonts-noto-core',
  'fonts-croscore',
  'ttf-mscorefonts-installer',
] as const;

// Reachable families (12 of the probe's 20), sourced verbatim from
// `.ac/plans/scraper-detectability-hardening/evidence/probe-baseline.md`.
// Helvetica and Liberation Sans come from `fonts-liberation`, which the base
// Playwright image installs via `install-deps`, not from a line in this Dockerfile.
const REACHABLE_FAMILIES = [
  'Arial',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Georgia',
  'Impact',
  'Trebuchet MS',
  'Comic Sans MS',
  'Helvetica',
  'Liberation Sans',
  'DejaVu Sans',
  'Noto Sans',
] as const;

// Package-dependent on Ubuntu: allowed to detect, but not required for the
// step's 12-of-20 threshold to hold.
const ALLOWED_NOT_REQUIRED_FAMILIES = ['Tahoma'] as const;

// Structurally unreachable with these four packages on a Linux desktop.
// Chasing any of these would be the "impossible combination" this step's
// Must NOT forbids: adding a font a Linux desktop cannot have.
const UNREACHABLE_FAMILIES = [
  'Segoe UI',
  'Calibri',
  'Cambria',
  'Consolas',
  'Roboto',
  'Ubuntu',
  'SF Pro Text',
] as const;

describe('font surface Dockerfile', () => {
  it('installs all four stock-desktop font packages', () => {
    for (const pkg of FONT_PACKAGES) {
      expect(dockerfile).toMatch(new RegExp(pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('pins the reachable family list at 12 of 20, plus Tahoma as allowed but not required', () => {
    expect(REACHABLE_FAMILIES).toHaveLength(12);
    expect(ALLOWED_NOT_REQUIRED_FAMILIES).toHaveLength(1);
  });

  it('pins the seven structurally unreachable families and does not chase them in the Dockerfile', () => {
    expect(UNREACHABLE_FAMILIES).toHaveLength(7);

    // None of these packages should ever be added; their presence would mean
    // someone tried to close an impossible combination.
    expect(dockerfile).not.toMatch(/fonts-roboto/);
    expect(dockerfile).not.toMatch(/fonts-ubuntu/);
  });

  it('reaches exactly 12 + 20 family bookkeeping (no double-counting, no gaps)', () => {
    const accounted = new Set([
      ...REACHABLE_FAMILIES,
      ...ALLOWED_NOT_REQUIRED_FAMILIES,
      ...UNREACHABLE_FAMILIES,
    ]);
    expect(accounted.size).toBe(20);
  });

  it('preseeds the mscorefonts EULA so the build cannot hang on interactive input', () => {
    expect(dockerfile).toMatch(/debconf-set-selections/);
    expect(dockerfile).toMatch(/ttf-mscorefonts-installer\s+msttcorefonts\/accepted-mscorefonts-eula/);
  });

  it('sets DEBIAN_FRONTEND=noninteractive ahead of the font install layer', () => {
    expect(dockerfile).toMatch(/ENV DEBIAN_FRONTEND=noninteractive/);
  });

  it('does not introduce a new floating :latest tag', () => {
    expect(dockerfile).not.toMatch(/:latest/);
  });
});
